import { createHash } from "node:crypto";
import { LangfuseOtelSpanAttributes, startObservation } from "@langfuse/tracing";
import type { IdeaWorkflowRecord } from "../domain/types.js";
import type { Observability } from "./index.js";
import { errorMessage, sanitizeTraceValue } from "./sanitize.js";

export interface IdeaWorkflowStageTrace {
  finish(output?: unknown, error?: unknown, metadata?: Record<string, unknown>): void;
}

export interface IdeaWorkflowTrace {
  startStage(name: string, input?: unknown): IdeaWorkflowStageTrace;
  finish(record: IdeaWorkflowRecord, error?: unknown): void;
}

const NOOP: IdeaWorkflowTrace = {
  startStage: () => ({ finish: () => {} }),
  finish: () => {},
};

export function createIdeaWorkflowTrace(
  observability: Observability,
  record: IdeaWorkflowRecord,
): IdeaWorkflowTrace {
  if (!observability.enabled) return NOOP;
  const root = startObservation("idea-workflow", {
    input: sanitizeTraceValue(record.input),
    metadata: {
      workflowId: record.id,
      projectId: record.projectId,
      idempotencyKeyHash: createHash("sha256").update(record.idempotencyKey).digest("hex").slice(0, 16),
      inputHash: record.inputHash,
      attempt: record.attempt,
      ...record.metadata,
    },
  }, { asType: "agent" });
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, "idea-workflow");
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, record.userId);
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, record.id);
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [
    "idea-workflow",
    `attempt:${record.attempt}`,
    `workflow-version:${record.metadata.workflowVersion}`,
  ]);

  return {
    startStage(name, input) {
      const startedAt = Date.now();
      const stage = root.startObservation(name, { input: sanitizeTraceValue(input) }, { asType: "span" });
      return {
        finish(output, error, metadata) {
          stage.update({
            output: sanitizeTraceValue(output),
            metadata: { durationMs: Date.now() - startedAt, ...metadata },
            ...(error ? { level: "ERROR", statusMessage: errorMessage(error) } : {}),
          });
          stage.end();
        },
      };
    },
    finish(finalRecord, error) {
      root.update({
        output: sanitizeTraceValue({
          status: finalRecord.status,
          stage: finalRecord.stage,
          ideaCount: finalRecord.ideas.length,
          imageFailures: finalRecord.ideas.filter((idea) => idea.image.status === "failed").length,
        }),
        metadata: {
          attempt: finalRecord.attempt,
          status: finalRecord.status,
          completedAt: finalRecord.completedAt,
        },
        ...(error ? { level: "ERROR", statusMessage: errorMessage(error) } : {}),
      });
      root.end();
    },
  };
}
