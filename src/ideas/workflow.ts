import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { OpsAssistant } from "../agent/assistant.js";
import type { AgentProfileId } from "../agent/profiles/catalog.js";
import { resolveAgentProfileById } from "../agent/profiles/registry.js";
import type { AppConfig } from "../config.js";
import type { GeneratedIdea, IdeaWorkflowRecord } from "../domain/types.js";
import type { IdeaAssetStore } from "../integrations/images/idea-asset-store.js";
import type { IdeaImageGenerator } from "../integrations/images/idea-image.js";
import { createId, JsonStore } from "../infrastructure/persistence/json-store.js";
import { createIdeaWorkflowTrace } from "../observability/idea-workflow.js";
import { disabledObservability, type Observability } from "../observability/index.js";
import { errorMessage } from "../observability/sanitize.js";

const WORKFLOW_VERSION = "idea-workflow-v2";
const PROMPT_VERSION = "idea-workflow-v2";

export interface IdeaWorkflowInput {
  userId: string;
  projectId?: string;
  theme: string;
  audience: string;
  emotion: string;
  duration: string;
  notes?: string;
  forbidden?: string;
  count: number;
}

interface AgentRunner {
  run(input: Parameters<OpsAssistant["run"]>[0]): Promise<string>;
}

const ideaIdSchema = z.string().trim().min(1).max(128);
const ideaTextSchema = z.string().trim().min(1).max(4_000);
const kernelSchema = z.object({
  id: ideaIdSchema, title: ideaTextSchema, mechanicFamily: ideaTextSchema,
  observation: ideaTextSchema, decision: ideaTextSchema, action: ideaTextSchema,
  stateTransition: ideaTextSchema, feedback: ideaTextSchema, loopContract: ideaTextSchema,
  predictionContract: ideaTextSchema, failureRecovery: ideaTextSchema, whyFun: ideaTextSchema,
  prototypeTest: ideaTextSchema,
});
const auditSchema = z.object({
  ideaId: ideaIdSchema, loopPass: z.boolean(), predictionPass: z.boolean(),
  interactionPass: z.boolean(), feasibilityPass: z.boolean(), costPass: z.boolean(),
  fatalReasons: z.array(ideaTextSchema).max(8), evidence: ideaTextSchema,
});
const selectedIdeaSchema = z.object({
  id: ideaIdSchema, title: ideaTextSchema, summary: ideaTextSchema, mechanic: ideaTextSchema,
  playerAction: ideaTextSchema, decision: ideaTextSchema, loop: ideaTextSchema,
  failureRecovery: ideaTextSchema, whyFun: ideaTextSchema, prototypeTest: ideaTextSchema,
  gatePassed: z.boolean(), fatalReasons: z.array(ideaTextSchema).max(8), imagePrompt: ideaTextSchema,
});
const inventionSchema = z.object({ kernels: z.array(kernelSchema).min(1).max(16) });
const auditsSchema = z.object({ audits: z.array(auditSchema).min(1).max(16) });
const convergenceSchema = z.object({ ideas: z.array(selectedIdeaSchema).min(1).max(8) });

type Invention = z.infer<typeof inventionSchema>;
type Audits = z.infer<typeof auditsSchema>;
type SelectedIdea = z.infer<typeof selectedIdeaSchema>;

export class IdeaWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeaWorkflowConflictError";
  }
}

class IdeaWorkflowCanceledError extends Error {}

function parseJsonOutput(output: string): unknown {
  if (output.length > 1_000_000) throw new Error("Idea Agent output exceeds 1 MB");
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Idea Agent did not return JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function baseBrief(input: IdeaWorkflowInput): Record<string, unknown> {
  return {
    theme: input.theme,
    audience: input.audience,
    emotion: input.emotion,
    platform: "Loopit 竖屏 Feed",
    duration: input.duration,
    notes: input.notes || "无",
    forbidden: input.forbidden || "未经授权的真实人物、品牌、Logo 和受版权保护素材",
    requestedCount: input.count,
  };
}

function inputHash(input: IdeaWorkflowInput): string {
  return createHash("sha256").update(JSON.stringify({
    userId: input.userId,
    projectId: input.projectId || null,
    ...baseBrief(input),
  })).digest("hex");
}

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
}

function validateAudits(kernels: Invention["kernels"], audits: Audits["audits"]): void {
  const expected = new Set(kernels.map((item) => item.id));
  const actual = audits.map((item) => item.ideaId);
  if (new Set(actual).size !== actual.length) throw new Error("audits contain duplicate ideaId values");
  const missing = [...expected].filter((id) => !actual.includes(id));
  const unknown = actual.filter((id) => !expected.has(id));
  if (missing.length || unknown.length) {
    throw new Error(`audit coverage mismatch: missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}`);
  }
}

function normalizeSelectedIdeas(
  selected: SelectedIdea[],
  desiredCount: number,
  kernels: Invention["kernels"],
  audits: Audits["audits"],
): SelectedIdea[] {
  if (selected.length !== desiredCount) throw new Error(`Idea Agent returned ${selected.length} ideas; expected ${desiredCount}`);
  assertUniqueIds(selected, "selected ideas");
  const candidates = new Set(kernels.map((item) => item.id));
  const auditById = new Map(audits.map((audit) => [audit.ideaId, audit]));
  const signatures = selected.map((idea) => `${idea.mechanic}\0${idea.decision}`.toLowerCase().replace(/\s+/g, " ").trim());
  if (new Set(signatures).size !== signatures.length) throw new Error("selected ideas contain duplicate mechanic and decision pairs");
  return selected.map((idea) => {
    if (!candidates.has(idea.id)) throw new Error(`selected idea is not a candidate: ${idea.id}`);
    const audit = auditById.get(idea.id)!;
    const gatePassed = [audit.loopPass, audit.predictionPass, audit.interactionPass, audit.feasibilityPass, audit.costPass]
      .every(Boolean) && audit.fatalReasons.length === 0;
    return { ...idea, gatePassed, fatalReasons: [...audit.fatalReasons] };
  });
}

export class IdeaWorkflow {
  private readonly activeJobs = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly agent: AgentRunner,
    private readonly images: IdeaImageGenerator,
    private readonly assets: IdeaAssetStore,
    private readonly observability: Observability = disabledObservability(),
  ) {}

  async start(input: IdeaWorkflowInput, idempotencyKey: string): Promise<{ workflow: IdeaWorkflowRecord; created: boolean }> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new Error("Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon or hyphen");
    }
    const hash = inputHash(input);
    const now = new Date().toISOString();
    const record: IdeaWorkflowRecord = {
      id: createId("idea"),
      idempotencyKey,
      inputHash: hash,
      userId: input.userId,
      projectId: input.projectId,
      status: "queued",
      stage: "queued",
      input: baseBrief(input),
      ideas: [],
      checkpoints: {},
      attempt: 0,
      cancelRequested: false,
      metadata: {
        workflowVersion: WORKFLOW_VERSION,
        promptVersion: PROMPT_VERSION,
        modelIds: [...new Set(["idea-inventor", "idea-auditor", "idea-converger"]
          .map((id) => resolveAgentProfileById(this.config, id as AgentProfileId).model.modelId))],
      },
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.store.createIdeaWorkflowIfAbsent(record);
    if (result.capacityExceeded) {
      throw new IdeaWorkflowConflictError("too many active idea workflows for user");
    }
    if (!result.created && result.record.inputHash !== hash) {
      throw new IdeaWorkflowConflictError("Idempotency-Key was already used with different input");
    }
    if (result.created || ["queued", "running"].includes(result.record.status)) this.schedule(result.record.id);
    return { workflow: result.record, created: result.created };
  }

  async run(input: IdeaWorkflowInput, idempotencyKey = `test-${createId("key")}`): Promise<IdeaWorkflowRecord> {
    const { workflow } = await this.start(input, idempotencyKey);
    await this.activeJobs.get(workflow.id);
    return this.store.getIdeaWorkflow(workflow.id)!;
  }

  resumePending(): void {
    for (const record of this.store.snapshot().ideaWorkflows) {
      if (["queued", "running"].includes(record.status)) this.schedule(record.id);
    }
  }

  async retry(id: string, userId: string): Promise<IdeaWorkflowRecord> {
    const record = this.store.getIdeaWorkflow(id);
    if (!record || record.userId !== userId) throw new Error("idea workflow not found");
    if (!["failed", "completed_with_errors", "canceled"].includes(record.status)) {
      throw new IdeaWorkflowConflictError(`workflow cannot be retried from status ${record.status}`);
    }
    const ideas = record.ideas.map((idea) => idea.image.status === "failed"
      ? { ...idea, image: { status: "pending" as const } }
      : idea);
    await this.store.updateIdeaWorkflow(id, {
      status: "queued",
      stage: record.checkpoints.convergence ? "images" : record.stage,
      ideas,
      cancelRequested: false,
      error: undefined,
      completedAt: undefined,
    });
    this.schedule(id);
    return this.store.getIdeaWorkflow(id)!;
  }

  async cancel(id: string, userId: string): Promise<IdeaWorkflowRecord> {
    const record = this.store.getIdeaWorkflow(id);
    if (!record || record.userId !== userId) throw new Error("idea workflow not found");
    if (!["queued", "running"].includes(record.status)) return record;
    await this.store.updateIdeaWorkflow(id, {
      cancelRequested: true,
      ...(record.status === "queued" ? { status: "canceled" as const, completedAt: new Date().toISOString() } : {}),
    });
    return this.store.getIdeaWorkflow(id)!;
  }

  async close(timeoutMs = 30_000): Promise<void> {
    const jobs = [...this.activeJobs.values()];
    if (!jobs.length) return;
    await Promise.race([
      Promise.allSettled(jobs).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private schedule(id: string): void {
    if (this.activeJobs.has(id)) return;
    const job = this.execute(id).finally(() => this.activeJobs.delete(id));
    this.activeJobs.set(id, job);
    void job.catch(() => undefined);
  }

  private async execute(id: string): Promise<void> {
    let record = this.store.getIdeaWorkflow(id);
    if (!record || record.status === "canceled") return;
    const attempt = record.attempt + 1;
    await this.store.updateIdeaWorkflow(id, {
      status: "running",
      attempt,
      startedAt: record.startedAt || new Date().toISOString(),
      error: undefined,
    });
    record = this.store.getIdeaWorkflow(id)!;
    const trace = createIdeaWorkflowTrace(this.observability, record);

    try {
      const desiredCount = Math.max(1, Math.min(8, Number(record.input.requestedCount) || 4));
      const kernelCount = Math.min(16, Math.max(desiredCount + 4, Math.ceil(desiredCount * 1.5)));
      const brief = record.input;
      this.throwIfCanceled(record.id);

      let invention: Invention | undefined;
      if (record.checkpoints.invention) {
        try {
          invention = inventionSchema.parse(record.checkpoints.invention);
          assertUniqueIds(invention.kernels, "kernels");
        } catch {
          await this.store.updateIdeaWorkflow(id, { checkpoints: {}, ideas: [] });
          record = this.store.getIdeaWorkflow(id)!;
        }
      }
      if (!invention) {
        await this.store.updateIdeaWorkflow(id, { stage: "invent" });
        invention = await this.structuredStage(
          trace, record, "idea-inventor", "invent", inventionSchema,
          `生成 ${kernelCount} 个不同的玩法内核。输入：\n${JSON.stringify(brief)}\n\n返回 {"kernels":[...]}。每项字段必须是 id、title、mechanicFamily、observation、decision、action、stateTransition、feedback、loopContract、predictionContract、failureRecovery、whyFun、prototypeTest。`,
          (value) => assertUniqueIds(value.kernels, "kernels"),
        );
        await this.store.updateIdeaWorkflow(id, { checkpoints: { ...record.checkpoints, invention } });
        record = this.store.getIdeaWorkflow(id)!;
      }
      assertUniqueIds(invention.kernels, "kernels");
      this.throwIfCanceled(id);

      let auditResult: Audits | undefined;
      if (record.checkpoints.audits) {
        try {
          auditResult = auditsSchema.parse(record.checkpoints.audits);
          validateAudits(invention.kernels, auditResult.audits);
        } catch {
          await this.store.updateIdeaWorkflow(id, {
            checkpoints: { invention },
            ideas: [],
          });
          record = this.store.getIdeaWorkflow(id)!;
        }
      }
      if (!auditResult) {
        await this.store.updateIdeaWorkflow(id, { stage: "audit" });
        auditResult = await this.structuredStage(
          trace, record, "idea-auditor", "audit", auditsSchema,
          `逐项审计候选。创作命题：\n${JSON.stringify(brief)}\n\n候选：\n${JSON.stringify(invention.kernels)}\n\n返回 {"audits":[...]}。每项字段必须是 ideaId、loopPass、predictionPass、interactionPass、feasibilityPass、costPass、fatalReasons、evidence。ideaId 对应候选 id。`,
          (value) => validateAudits(invention!.kernels, value.audits),
        );
        await this.store.updateIdeaWorkflow(id, { checkpoints: { ...record.checkpoints, invention, audits: auditResult } });
        record = this.store.getIdeaWorkflow(id)!;
      }
      validateAudits(invention.kernels, auditResult.audits);
      this.throwIfCanceled(id);

      let selected: SelectedIdea[];
      if (record.checkpoints.convergence) {
        try {
          selected = normalizeSelectedIdeas(
            z.array(selectedIdeaSchema).parse(record.checkpoints.convergence),
            desiredCount,
            invention.kernels,
            auditResult.audits,
          );
        } catch {
          await this.store.updateIdeaWorkflow(id, {
            checkpoints: { invention, audits: auditResult },
            ideas: [],
          });
          record = this.store.getIdeaWorkflow(id)!;
          selected = [];
        }
      } else {
        selected = [];
      }
      if (selected.length === 0) {
        await this.store.updateIdeaWorkflow(id, { stage: "converge" });
        const convergence = await this.structuredStage(
          trace, record, "idea-converger", "converge", convergenceSchema,
          `从候选中选择 ${desiredCount} 个方向并规格化。创作命题：\n${JSON.stringify(brief)}\n\n候选：\n${JSON.stringify(invention.kernels)}\n\n审计：\n${JSON.stringify(auditResult.audits)}\n\n返回 {"ideas":[...]}，必须正好 ${desiredCount} 项。每项字段必须是 id、title、summary、mechanic、playerAction、decision、loop、failureRecovery、whyFun、prototypeTest、gatePassed、fatalReasons、imagePrompt。`,
          (value) => { normalizeSelectedIdeas(value.ideas, desiredCount, invention!.kernels, auditResult!.audits); },
        );
        selected = normalizeSelectedIdeas(convergence.ideas, desiredCount, invention.kernels, auditResult.audits);
        const pendingIdeas = selected.map((idea) => ({ ...idea, image: { status: "pending" as const } }));
        await this.store.updateIdeaWorkflow(id, {
          checkpoints: { ...record.checkpoints, invention, audits: auditResult, convergence: selected },
          ideas: pendingIdeas,
        });
        record = this.store.getIdeaWorkflow(id)!;
      }
      this.throwIfCanceled(id);

      await this.store.updateIdeaWorkflow(id, { stage: "images" });
      await this.generateImages(trace, this.store.getIdeaWorkflow(id)!);
      record = this.store.getIdeaWorkflow(id)!;
      this.throwIfCanceled(id);
      const status = record.ideas.some((idea) => idea.image.status === "failed")
        ? "completed_with_errors" : "completed";
      await this.store.updateIdeaWorkflow(id, {
        status,
        stage: "complete",
        completedAt: new Date().toISOString(),
      });
      trace.finish(this.store.getIdeaWorkflow(id)!);
    } catch (error) {
      if (error instanceof IdeaWorkflowCanceledError) {
        await this.store.updateIdeaWorkflow(id, {
          status: "canceled",
          completedAt: new Date().toISOString(),
          error: undefined,
        });
      } else {
        await this.store.updateIdeaWorkflow(id, {
          status: "failed",
          error: errorMessage(error),
          completedAt: new Date().toISOString(),
        });
      }
      trace.finish(this.store.getIdeaWorkflow(id)!, error);
      throw error;
    }
  }

  private async structuredStage<T>(
    trace: ReturnType<typeof createIdeaWorkflowTrace>,
    record: IdeaWorkflowRecord,
    profileId: AgentProfileId,
    stage: string,
    schema: z.ZodType<T>,
    prompt: string,
    validate?: (value: T) => void,
  ): Promise<T> {
    let lastError: unknown;
    for (let run = 1; run <= 2; run += 1) {
      const span = trace.startStage(stage, { profileId, run });
      try {
        const output = await this.runStage(record, profileId, stage, prompt, run);
        const parsed = schema.parse(parseJsonOutput(output));
        validate?.(parsed);
        span.finish({ valid: true }, undefined, { run });
        return parsed;
      } catch (error) {
        lastError = error;
        span.finish(undefined, error, { run });
        if (run === 2) throw error;
      }
    }
    throw lastError;
  }

  private async runStage(record: IdeaWorkflowRecord, profileId: AgentProfileId, stage: string, prompt: string, run: number): Promise<string> {
    if (this.config.assistantDryRun) return this.dryRunStage(stage, prompt);
    const root = join(this.config.dataDir, "idea-workflows", record.id, `attempt-${record.attempt}`, `${stage}-${run}`);
    return this.agent.run({
      type: "interactive",
      profileId,
      userId: record.userId,
      imThreadId: record.id,
      runId: `${record.id}:${record.attempt}:${stage}:${run}`,
      prompt,
      workDir: join(root, "work"),
      sessionDir: join(root, "session"),
      continueSession: false,
      sessionMode: "new",
      traceContext: { workflowId: record.id, stage, attempt: record.attempt },
    });
  }

  private async generateImages(trace: ReturnType<typeof createIdeaWorkflowTrace>, record: IdeaWorkflowRecord): Promise<void> {
    let cursor = 0;
    const indexes = record.ideas.map((idea, index) => ({ idea, index }))
      .filter(({ idea }) => idea.image.status !== "completed")
      .map(({ index }) => index);
    const worker = async (): Promise<void> => {
      while (cursor < indexes.length) {
        const index = indexes[cursor++];
        this.throwIfCanceled(record.id);
        const current = this.store.getIdeaWorkflow(record.id)!;
        const idea = current.ideas[index];
        const span = trace.startStage("image", { ideaId: idea.id });
        try {
          const artifact = await this.generateImageWithRetry({
            workflowId: record.id,
            ideaId: idea.id,
            prompt: `Create a polished 9:16 vertical mobile game screenshot, not a poster. Clearly show the playable surface, player action, goal, changing state, success or failure feedback, and readable icon-based UI. ${idea.imagePrompt}`,
          });
          if (artifact.bytes.length === 0 || artifact.bytes.length > 20 * 1024 * 1024) {
            throw new Error(`generated image size is invalid: ${artifact.bytes.length} bytes`);
          }
          const stored = await this.putAssetWithRetry({
            userId: record.userId,
            projectId: record.projectId,
            workflowId: record.id,
            ideaId: idea.id,
            bytes: artifact.bytes,
            mimeType: artifact.mimeType,
          });
          current.ideas[index] = {
            ...idea,
            image: {
              status: "completed",
              url: stored.url,
              mimeType: artifact.mimeType,
              model: artifact.model,
              storage: stored.storage,
            },
          };
          await this.store.updateIdeaWorkflow(record.id, { ideas: current.ideas });
          span.finish({ status: "completed", storage: stored.storage }, undefined, { model: artifact.model });
        } catch (error) {
          current.ideas[index] = {
            ...idea,
            image: { status: "failed", error: errorMessage(error) },
          };
          await this.store.updateIdeaWorkflow(record.id, { ideas: current.ideas });
          span.finish({ status: "failed" }, error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, indexes.length) }, () => worker()));
  }

  private async generateImageWithRetry(input: Parameters<IdeaImageGenerator["generate"]>[0]) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.images.generate(input);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/(429|5\d\d|timeout|temporar|network|fetch failed|ECONNRESET|ETIMEDOUT)/i.test(message) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
      }
    }
    throw lastError;
  }

  private async putAssetWithRetry(input: Parameters<IdeaAssetStore["put"]>[0]) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.assets.put(input);
      } catch (error) {
        lastError = error;
        const status = Number((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode || 0);
        const message = error instanceof Error ? error.message : String(error);
        const transient = status === 429 || status >= 500 || /(timeout|temporar|network|ECONNRESET|ETIMEDOUT)/i.test(message);
        if (!transient || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
      }
    }
    throw lastError;
  }

  private throwIfCanceled(id: string): void {
    if (this.store.getIdeaWorkflow(id)?.cancelRequested) throw new IdeaWorkflowCanceledError("workflow canceled");
  }

  private dryRunStage(stage: string, prompt: string): string {
    if (stage === "invent") return JSON.stringify({ kernels: Array.from({ length: 8 }, (_, index) => ({
      id: `dry-${index + 1}`, title: `Dry-run Idea ${index + 1}`, mechanicFamily: index % 2 ? "timing" : "spatial",
      observation: "A visible target changes state.", decision: "Choose the next target before the timer closes.",
      action: "Tap or drag the selected object.", stateTransition: "The target resolves and the next target appears.",
      feedback: "Immediate success or recoverable miss feedback.", loopContract: "A complete decision loop every 4 seconds.",
      predictionContract: "A visible countdown appears 1 second before resolution.", failureRecovery: "A miss resets only the current target.",
      whyFun: "Fast readable decisions create mastery.", prototypeTest: "Test whether new players complete three loops in 30 seconds.",
    })) });
    if (stage === "audit") return JSON.stringify({ audits: Array.from({ length: 8 }, (_, index) => ({
      ideaId: `dry-${index + 1}`, loopPass: true, predictionPass: true, interactionPass: true,
      feasibilityPass: true, costPass: true, fatalReasons: [],
      evidence: "Visible countdown, direct input, deterministic resolution and immediate retry are specified.",
    })) });
    const count = Number(prompt.match(/正好\s+(\d+)\s+项/)?.[1] || 4);
    return JSON.stringify({ ideas: Array.from({ length: count }, (_, index) => ({
      id: `dry-${index + 1}`, title: `Dry-run Idea ${index + 1}`, summary: "A short, visible decision loop for a vertical mobile game.",
      mechanic: `Choose and resolve changing target pattern ${index + 1}.`, playerAction: "Tap or drag with one thumb.",
      decision: "Select the best target before time closes.", loop: "Observe, choose, act, resolve, repeat in four seconds.",
      failureRecovery: "Only the current target resets after a miss.", whyFun: "Readable pressure and quick mastery.",
      prototypeTest: "Three successful loops within 30 seconds.", gatePassed: true, fatalReasons: [],
      imagePrompt: "A clean portrait game board with targets, countdown, score and a visible successful tap.",
    })) });
  }
}
