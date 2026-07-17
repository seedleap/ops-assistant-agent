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
  baseBrief,
  convergenceSchema,
  DEFAULT_IDEA_PROJECT_ID,
  inputHash,
  inventionSchema,
  normalizeSelectedIdeas,
  PROMPT_VERSION,
  selectedIdeaSchema,
  WORKFLOW_VERSION,
  type IdeaWorkflowInput,
  type Invention,
  type SelectedIdea,
} from "./contracts.js";
import { IdeaImagePipeline } from "./image-pipeline.js";
import { IdeaStageRunner, type AgentRunner } from "./stage-runner.js";

export type { IdeaWorkflowInput } from "./contracts.js";

const IDEA_STAGE_PROFILE_IDS = ["idea-inventor", "idea-converger"] as const satisfies readonly AgentProfileId[];

function currentWorkflowMetadata(config: AppConfig): IdeaWorkflowRecord["metadata"] {
  return {
    workflowVersion: WORKFLOW_VERSION,
    promptVersion: PROMPT_VERSION,
    modelIds: [...new Set(IDEA_STAGE_PROFILE_IDS.map((id) => resolveAgentProfileById(config, id).model.modelId))],
  };
}

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
      metadata: currentWorkflowMetadata(this.config),
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
    const versionChanged = record.metadata.workflowVersion !== WORKFLOW_VERSION;
    const ideas = versionChanged ? [] : record.ideas.map((idea) => idea.image.status === "failed"
      ? { ...idea, image: { status: "pending" as const } }
      : idea);
    await this.store.updateIdeaWorkflow(id, {
      status: "queued",
      stage: versionChanged ? "queued" : record.checkpoints.convergence ? "images" : record.stage,
      ideas,
      ...(versionChanged ? { checkpoints: {}, metadata: currentWorkflowMetadata(this.config) } : {}),
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
    if (record.metadata.workflowVersion !== WORKFLOW_VERSION) {
      await this.store.updateIdeaWorkflow(id, {
        stage: "queued",
        ideas: [],
        checkpoints: {},
        metadata: currentWorkflowMetadata(this.config),
      });
      record = this.store.getIdeaWorkflow(id)!;
    }
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
      const kernelCount = Math.min(16, Math.max(desiredCount + 6, Math.ceil(desiredCount * 1.5)));
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
          `先为下面的命题发散 ${kernelCount} 个玩法内核，不要直接写成包装完整的游戏提案。\n\n创作命题：\n${JSON.stringify(brief)}\n\n返回 {"kernels":[...]}，必须正好 ${kernelCount} 项。每项字段必须是 id、title、mechanicFamily、interactionPattern、mechanicAnchor、coreAction、gameState、playerDecision、tension、failAndRecovery、masteryGrowth、variationSource、themeBinding、whyFun、antiClone。interactionPattern 只能是 tap-choice、timing、drag-track、swipe-path、hold-release、sequence、resource-allocation、spatial-arrangement、other 之一。覆盖空间、时机、观察、排序、路径、组合、资源分配、风险决策等不同机制家族。以下方向直接淘汰：只点击光点、爱心或目标来点亮或攒能量；只有收集和进度条没有判断；把不同颜色、角色、轨道或节拍当成玩法差异；只能靠叙事、IP 或精美美术才有趣。只输出 JSON，不要解释或 Markdown。`,
          (value) => {
            assertUniqueIds(value.kernels, "kernels");
            if (value.kernels.length !== kernelCount) {
              throw new Error(`Idea Agent returned ${value.kernels.length} kernels; expected ${kernelCount}`);
            }
          },
        );
        await this.store.updateIdeaWorkflow(id, { checkpoints: { ...record.checkpoints, invention } });
        record = this.store.getIdeaWorkflow(id)!;
      }
      assertUniqueIds(invention.kernels, "kernels");
      this.throwIfCanceled(id);

      let selected: SelectedIdea[];
      if (record.checkpoints.convergence) {
        try {
          selected = normalizeSelectedIdeas(
            z.array(selectedIdeaSchema).parse(record.checkpoints.convergence),
            desiredCount,
            invention.kernels,
          );
        } catch {
          await this.store.updateIdeaWorkflow(id, {
            checkpoints: { invention },
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
          `先红队淘汰伪玩法，再从候选中选出 ${desiredCount} 个真正不同、最可能好玩的方向并规格化。\n\n创作命题：\n${JSON.stringify(brief)}\n\n候选玩法内核：\n${JSON.stringify(invention.kernels)}\n\n选择硬门槛：\n1. 3-5 秒能理解第一次有效操作，但不是无脑点击。\n2. 玩家判断会改变局面，存在成功、近失误、失败和恢复。\n3. 结果能由可见信号合理预判。\n4. 30-60 秒内至少出现两次难度或策略升级。\n5. 第二局的局面、目标、资源或路线会变化，而不只是分数重置。\n6. 去掉主题包装后灰盒仍成立；主题又能自然改变规则或反馈。\n7. ${desiredCount} 个方向的底层动作与判断不得重复，不能用不同颜色、角色或轨道冒充差异。\n\n返回 {"ideas":[...]}，必须正好 ${desiredCount} 项。每项字段必须是 id、title、summary、mechanic、interactionPattern、playerGoal、playerAction、gameState、decision、rules、loop、failState、feedback、failureRecovery、whyFun、prototypeTest、difficultyCurve、variationSource、first10Seconds、funRisks、bindingRationale、imagePrompt、audit。id 必须沿用候选 id，interactionPattern 必须与候选一致。audit 必须包含 loopPass、predictionPass、interactionPass、feasibilityPass、fatalReasons、evidence、recommendedDowngrade；它是本次 V1 红队收敛判断，不是独立 Agent 审计。除 audit.fatalReasons 必须为字符串数组外，rules、loop、difficultyCurve、funRisks、audit.evidence 和其他文本字段都必须是单个 JSON 字符串，不得返回数组。玩法字段必须具体到对象、状态、阈值或条件；imagePrompt 必须描述真实竖屏游戏画面和可操作信息。不要输出 gatePassed，它由程序根据 audit 推导。只输出 JSON，不要解释或 Markdown。`,
          (value) => { normalizeSelectedIdeas(value.ideas, desiredCount, invention!.kernels); },
        );
        selected = normalizeSelectedIdeas(convergence.ideas, desiredCount, invention.kernels);
        const pendingIdeas = selected.map((idea) => ({ ...idea, image: { status: "pending" as const } }));
        await this.store.updateIdeaWorkflow(id, {
          checkpoints: { invention, convergence: selected },
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
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
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
