import { createHash } from "node:crypto";
import { z } from "zod";

export const WORKFLOW_VERSION = "idea-workflow-v2";
export const PROMPT_VERSION = "idea-workflow-v2";

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

const ideaIdSchema = z.string().trim().min(1).max(128);
const ideaTextSchema = z.string().trim().min(1).max(4_000);
export const interactionPatternSchema = z.enum([
  "tap-choice", "timing", "drag-track", "swipe-path", "hold-release",
  "sequence", "resource-allocation", "spatial-arrangement", "other",
]);

export const kernelSchema = z.object({
  id: ideaIdSchema, title: ideaTextSchema, mechanicFamily: ideaTextSchema,
  interactionPattern: interactionPatternSchema,
  observation: ideaTextSchema, decision: ideaTextSchema, action: ideaTextSchema,
  stateTransition: ideaTextSchema, feedback: ideaTextSchema, loopContract: ideaTextSchema,
  predictionContract: ideaTextSchema, visibleSignal: ideaTextSchema,
  predictionWindow: ideaTextSchema, nextDecision: ideaTextSchema,
  failureRecovery: ideaTextSchema, whyFun: ideaTextSchema, prototypeTest: ideaTextSchema,
});

export const auditSchema = z.object({
  ideaId: ideaIdSchema, loopPass: z.boolean(), predictionPass: z.boolean(),
  interactionPass: z.boolean(), feasibilityPass: z.boolean(),
  fatalReasons: z.array(ideaTextSchema).max(8), evidence: ideaTextSchema,
  recommendedDowngrade: ideaTextSchema,
});

export const selectedIdeaDraftSchema = z.object({
  id: ideaIdSchema, title: ideaTextSchema, summary: ideaTextSchema, mechanic: ideaTextSchema,
  interactionPattern: interactionPatternSchema,
  playerGoal: ideaTextSchema, playerAction: ideaTextSchema, gameState: ideaTextSchema,
  decision: ideaTextSchema, rules: ideaTextSchema, loop: ideaTextSchema,
  failState: ideaTextSchema, feedback: ideaTextSchema,
  failureRecovery: ideaTextSchema, whyFun: ideaTextSchema, prototypeTest: ideaTextSchema,
  difficultyCurve: ideaTextSchema, variationSource: ideaTextSchema,
  first10Seconds: ideaTextSchema, funRisks: ideaTextSchema, bindingRationale: ideaTextSchema,
  imagePrompt: ideaTextSchema,
});
export const selectedIdeaSchema = selectedIdeaDraftSchema.extend({
  gatePassed: z.boolean(), fatalReasons: z.array(ideaTextSchema).max(8),
  audit: auditSchema.omit({ ideaId: true }),
});

export const inventionSchema = z.object({ kernels: z.array(kernelSchema).min(1).max(16) });
export const auditsSchema = z.object({ audits: z.array(auditSchema).min(1).max(16) });
export const convergenceSchema = z.object({ ideas: z.array(selectedIdeaDraftSchema).min(1).max(8) });

export type Invention = z.infer<typeof inventionSchema>;
export type Audits = z.infer<typeof auditsSchema>;
export type SelectedIdeaDraft = z.infer<typeof selectedIdeaDraftSchema>;
export type SelectedIdea = z.infer<typeof selectedIdeaSchema>;

export function parseJsonOutput(output: string): unknown {
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

export function baseBrief(input: IdeaWorkflowInput): Record<string, unknown> {
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

export function inputHash(input: IdeaWorkflowInput): string {
  return createHash("sha256").update(JSON.stringify({
    userId: input.userId,
    projectId: input.projectId || null,
    ...baseBrief(input),
  })).digest("hex");
}

export function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
}

export function validateAudits(kernels: Invention["kernels"], audits: Audits["audits"]): void {
  const expected = new Set(kernels.map((item) => item.id));
  const actual = audits.map((item) => item.ideaId);
  if (new Set(actual).size !== actual.length) throw new Error("audits contain duplicate ideaId values");
  const missing = [...expected].filter((id) => !actual.includes(id));
  const unknown = actual.filter((id) => !expected.has(id));
  if (missing.length || unknown.length) {
    throw new Error(`audit coverage mismatch: missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}`);
  }
  for (const audit of audits) {
    const allPassed = [
      audit.loopPass,
      audit.predictionPass,
      audit.interactionPass,
      audit.feasibilityPass,
    ].every(Boolean);
    if (allPassed !== (audit.fatalReasons.length === 0)) {
      throw new Error(`audit verdict is inconsistent for ${audit.ideaId}`);
    }
  }
}

export function normalizeSelectedIdeas(
  selected: SelectedIdeaDraft[],
  desiredCount: number,
  kernels: Invention["kernels"],
  audits: Audits["audits"],
): SelectedIdea[] {
  if (selected.length !== desiredCount) throw new Error(`Idea Agent returned ${selected.length} ideas; expected ${desiredCount}`);
  assertUniqueIds(selected, "selected ideas");
  const candidates = new Set(kernels.map((item) => item.id));
  const candidateById = new Map(kernels.map((item) => [item.id, item]));
  const auditById = new Map(audits.map((audit) => [audit.ideaId, audit]));
  const signatures = selected.map((idea) => `${idea.mechanic}\0${idea.decision}`.toLowerCase().replace(/\s+/g, " ").trim());
  if (new Set(signatures).size !== signatures.length) throw new Error("selected ideas contain duplicate mechanic and decision pairs");
  const availablePatterns = new Set(kernels.map((item) => item.interactionPattern));
  const selectedPatterns = new Set(selected.map((item) => item.interactionPattern));
  if (availablePatterns.size >= desiredCount && selectedPatterns.size !== selected.length) {
    throw new Error("selected ideas reuse an interaction pattern despite diverse candidates");
  }
  return selected.map((idea) => {
    if (!candidates.has(idea.id)) throw new Error(`selected idea is not a candidate: ${idea.id}`);
    if (candidateById.get(idea.id)!.interactionPattern !== idea.interactionPattern) {
      throw new Error(`selected idea changed interaction pattern: ${idea.id}`);
    }
    const audit = auditById.get(idea.id)!;
    const gatePassed = [audit.loopPass, audit.predictionPass, audit.interactionPass, audit.feasibilityPass]
      .every(Boolean) && audit.fatalReasons.length === 0;
    return {
      ...idea,
      gatePassed,
      fatalReasons: [...audit.fatalReasons],
      audit: {
        loopPass: audit.loopPass,
        predictionPass: audit.predictionPass,
        interactionPass: audit.interactionPass,
        feasibilityPass: audit.feasibilityPass,
        fatalReasons: [...audit.fatalReasons],
        evidence: audit.evidence,
        recommendedDowngrade: audit.recommendedDowngrade,
      },
    };
  });
}
