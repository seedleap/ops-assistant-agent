import { z } from "zod";
import type { AgentProfileId } from "../agent/profiles/catalog.js";
import { resolveAgentProfileById } from "../agent/profiles/registry.js";
import type { AppConfig } from "../config.js";
import type { IdeaWorkflowRecord } from "../domain/types.js";
import type { IdeaAssetStore } from "../integrations/images/idea-asset-store.js";
import type { IdeaImageGenerator } from "../integrations/images/idea-image.js";
import { createId, JsonStore } from "../infrastructure/persistence/json-store.js";
import { createIdeaWorkflowTrace } from "../observability/idea-workflow.js";
import { disabledObservability, type Observability } from "../observability/index.js";
import { errorMessage } from "../observability/sanitize.js";
import {
  assertUniqueIds,
  auditsSchema,
  baseBrief,
  convergenceSchema,
  DEFAULT_IDEA_PROJECT_ID,
  inputHash,
  inventionSchema,
  normalizeSelectedIdeas,
  PROMPT_VERSION,
  selectedIdeaSchema,
  validateAudits,
  WORKFLOW_VERSION,
  type Audits,
  type IdeaWorkflowInput,
  type Invention,
  type SelectedIdea,
} from "./contracts.js";
import { IdeaImagePipeline } from "./image-pipeline.js";
import { IdeaStageRunner, type AgentRunner } from "./stage-runner.js";

export type { IdeaWorkflowInput } from "./contracts.js";

export class IdeaWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeaWorkflowConflictError";
  }
}

class IdeaWorkflowCanceledError extends Error {}

export class IdeaWorkflow {
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly stages: IdeaStageRunner;
  private readonly imagePipeline: IdeaImagePipeline;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    agent: AgentRunner,
    images: IdeaImageGenerator,
    assets: IdeaAssetStore,
    private readonly observability: Observability = disabledObservability(),
  ) {
    this.stages = new IdeaStageRunner(config, agent);
    this.imagePipeline = new IdeaImagePipeline(store, images, assets);
  }

  async start(input: IdeaWorkflowInput, idempotencyKey: string): Promise<{ workflow: IdeaWorkflowRecord; created: boolean }> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new Error("Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon or hyphen");
    }
    const normalizedInput = { ...input, projectId: input.projectId || DEFAULT_IDEA_PROJECT_ID };
    const hash = inputHash(normalizedInput);
    const now = new Date().toISOString();
    const record: IdeaWorkflowRecord = {
      id: createId("idea"),
      idempotencyKey,
      inputHash: hash,
      userId: input.userId,
      projectId: normalizedInput.projectId,
      status: "queued",
      stage: "queued",
      input: baseBrief(normalizedInput),
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
          `生成 ${kernelCount} 个不同的玩法内核。输入：\n${JSON.stringify(brief)}\n\n返回 {"kernels":[...]}。每项字段必须是 id、title、mechanicFamily、interactionPattern、observation、decision、action、stateTransition、feedback、loopContract、predictionContract、visibleSignal、predictionWindow、nextDecision、failureRecovery、whyFun、prototypeTest。interactionPattern 只能是 tap-choice、timing、drag-track、swipe-path、hold-release、sequence、resource-allocation、spatial-arrangement、other 之一。visibleSignal 写玩家能直接看到的预告，predictionWindow 写信号领先结果多久，nextDecision 写本轮反馈如何产生下一次不同判断。候选应尽量覆盖不同 interactionPattern。`,
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
          `逐项审计候选。创作命题：\n${JSON.stringify(brief)}\n\n候选：\n${JSON.stringify(invention.kernels)}\n\n返回 {"audits":[...]}。每项字段必须是 ideaId、loopPass、predictionPass、interactionPass、feasibilityPass、fatalReasons、evidence、recommendedDowngrade。ideaId 对应候选 id。fatalReasons 必须始终是 JSON 数组，无问题时返回 []，禁止返回字符串；evidence 必须引用候选中的具体机制；recommendedDowngrade 写审核失败时不改变核心玩法的最小降级建议，通过时写“无需降级”。loopContract 若只是整局目标而非 3-5 秒观察→判断→动作→反馈闭环，loopPass 必须为 false；visibleSignal 不可见、predictionWindow 没有明确提前量或 nextDecision 不产生新判断时，predictionPass 必须为 false。任何 fatalReasons 都必须至少对应一个 false；任何 false 都必须说明 fatalReasons。`,
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
          `从候选中选择 ${desiredCount} 个方向并规格化。创作命题：\n${JSON.stringify(brief)}\n\n候选：\n${JSON.stringify(invention.kernels)}\n\n审计：\n${JSON.stringify(auditResult.audits)}\n\n返回 {"ideas":[...]}，必须正好 ${desiredCount} 项。每项字段必须是 id、title、summary、mechanic、interactionPattern、playerGoal、playerAction、gameState、decision、rules、loop、failState、feedback、failureRecovery、whyFun、prototypeTest、difficultyCurve、variationSource、first10Seconds、funRisks、bindingRationale、imagePrompt。玩法字段必须具体到对象、状态、阈值或条件；first10Seconds 写清前 10 秒发生什么；difficultyCurve 写 30-60 秒内如何至少升级两次；variationSource 写下一局为何不同；funRisks 写最需要真人验证的好玩风险。interactionPattern 必须与原候选一致；当候选中存在足够多不同 interactionPattern 时，最终结果不得重复 interactionPattern。gatePassed、fatalReasons 和完整 audit 由程序根据审计结果附加，不要输出。只输出 JSON，不要解释或 Markdown。`,
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
      await this.imagePipeline.run(trace, this.store.getIdeaWorkflow(id)!, () => this.throwIfCanceled(id));
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
    return this.stages.run({
      trace,
      record,
      profileId,
      stage,
      schema,
      prompt,
      validate,
    });
  }

  private throwIfCanceled(id: string): void {
    if (this.store.getIdeaWorkflow(id)?.cancelRequested) throw new IdeaWorkflowCanceledError("workflow canceled");
  }
}
