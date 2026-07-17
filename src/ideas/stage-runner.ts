import { join } from "node:path";
import type { z } from "zod";
import type { OpsAssistant } from "../agent/assistant.js";
import type { AgentProfileId } from "../agent/profiles/catalog.js";
import type { AppConfig } from "../config.js";
import type { IdeaWorkflowRecord } from "../domain/types.js";
import type { createIdeaWorkflowTrace } from "../observability/idea-workflow.js";
import { errorMessage } from "../observability/sanitize.js";
import { parseJsonOutput } from "./contracts.js";

export interface AgentRunner {
  run(input: Parameters<OpsAssistant["run"]>[0]): Promise<string>;
}

interface StageInput<T> {
  trace: ReturnType<typeof createIdeaWorkflowTrace>;
  record: IdeaWorkflowRecord;
  profileId: AgentProfileId;
  stage: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  prompt: string;
  validate?: (value: T) => void;
}

export class IdeaStageRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly agent: AgentRunner,
  ) {}

  async run<T>({ trace, record, profileId, stage, schema, prompt, validate }: StageInput<T>): Promise<T> {
    let lastError: unknown;
    for (let run = 1; run <= 2; run += 1) {
      const span = trace.startStage(stage, { profileId, run });
      try {
        const effectivePrompt = run === 1 ? prompt : `${prompt}\n\n上一次输出未通过校验：${errorMessage(lastError).slice(0, 2_000)}\n请只修正 JSON 字段、类型、数量和重复项，不要添加解释或 Markdown。`;
        const output = await this.invoke(record, profileId, stage, effectivePrompt, run, span.parentSpanContext);
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

  private async invoke(
    record: IdeaWorkflowRecord,
    profileId: AgentProfileId,
    stage: string,
    prompt: string,
    run: number,
    parentSpanContext?: NonNullable<NonNullable<Parameters<AgentRunner["run"]>[0]["traceContext"]>["parentSpanContext"]>,
  ): Promise<string> {
    if (this.config.assistantDryRun) return dryRunStage(stage, prompt);
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
      traceContext: {
        workflowId: record.id,
        stage,
        attempt: record.attempt,
        ...(parentSpanContext ? { parentSpanContext } : {}),
      },
    });
  }
}

function dryRunStage(stage: string, prompt: string): string {
  if (stage === "invent") {
    const kernelCount = Number(prompt.match(/发散\s+(\d+)\s+个玩法内核/)?.[1] || 8);
    return JSON.stringify({ kernels: Array.from({ length: kernelCount }, (_, index) => ({
      id: `dry-${index + 1}`, title: `Dry-run Idea ${index + 1}`, mechanicFamily: index % 2 ? "timing" : "spatial",
      interactionPattern: index % 2 ? "timing" : "drag-track",
      mechanicAnchor: "A visible target changes state before it can be resolved.",
      coreAction: "Tap or drag the selected object.", gameState: "Targets alternate between warned, active and resolved.",
      playerDecision: "Choose the next target before the timer closes.", tension: "Waiting improves certainty but reduces time.",
      failAndRecovery: "A miss resets only the current target.", masteryGrowth: "Players learn warning order and timing.",
      variationSource: "Target positions and warning order change each run.",
      themeBinding: "The theme controls target state and feedback.", whyFun: "Fast readable decisions create mastery.",
      antiClone: "The changing warning order prevents the loop from becoming a fixed tap sequence.",
    })) });
  }
  const count = Number(prompt.match(/正好\s+(\d+)\s+项/)?.[1] || 4);
  return JSON.stringify({ ideas: Array.from({ length: count }, (_, index) => ({
    id: `dry-${index + 1}`, title: `Dry-run Idea ${index + 1}`, summary: "A short, visible decision loop for a vertical mobile game.",
    mechanic: `Choose and resolve changing target pattern ${index + 1}.`,
    interactionPattern: index % 2 ? "timing" : "drag-track",
    playerGoal: "Resolve as many changing targets as possible before the 30-second timer ends.",
    playerAction: "Tap or drag with one thumb.", gameState: "Targets alternate between warned, active and resolved states.",
    decision: "Select the best target before time closes.", rules: "Only the visibly warned target scores; a miss resets that target.",
    loop: "Observe, choose, act, resolve, repeat in four seconds.", failState: "The active target expires before the player resolves it.",
    feedback: "The target flashes and the next warning appears immediately.",
    failureRecovery: "Only the current target resets after a miss.", whyFun: "Readable pressure and quick mastery.",
    prototypeTest: "Three successful loops within 30 seconds.",
    difficultyCurve: "Warnings shorten after 10 seconds and targets begin moving after 20 seconds.",
    variationSource: "Target positions and warning order are shuffled each run.",
    first10Seconds: "One guided target teaches the signal, then three normal four-second loops begin.",
    funRisks: "Verify that reading the warning creates a real choice instead of a reflex tap.",
    bindingRationale: "The visible target theme directly controls state and feedback.",
    audit: {
      loopPass: true, predictionPass: true, interactionPass: true, feasibilityPass: true,
      fatalReasons: [],
      evidence: "Visible warning, consequential input, state change and immediate recovery are specified.",
      recommendedDowngrade: "No downgrade needed.",
    },
    imagePrompt: "A clean portrait game board with targets, countdown, score and a visible successful tap.",
  })) });
}
