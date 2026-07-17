import { LangfuseOtelSpanAttributes, startObservation } from "@langfuse/tracing";
import type { IdeaWorkflowRecord } from "../domain/types.js";
import type { Observability } from "./index.js";
import { errorMessage, sanitizeTraceValue } from "./sanitize.js";

export interface IdeaWorkflowStageTrace {
  parentSpanContext?: {
    traceId: string;
    spanId: string;
    traceFlags: number;
    isRemote?: boolean;
  };
  finish(output?: unknown, error?: unknown, metadata?: Record<string, unknown>): void;
}

export interface IdeaWorkflowTrace {
  startStage(name: string, input?: unknown): IdeaWorkflowStageTrace;
  startImage(index: number, input: unknown): IdeaWorkflowStageTrace;
  finish(record: IdeaWorkflowRecord, error?: unknown): void;
}

const NOOP: IdeaWorkflowTrace = {
  startStage: () => ({ finish: () => {} }),
  startImage: () => ({ finish: () => {} }),
  finish: () => {},
};

export function createIdeaWorkflowTrace(
  observability: Observability,
  record: IdeaWorkflowRecord,
): IdeaWorkflowTrace {
  if (!observability.enabled) return NOOP;
  let turnCount = 0;
  const root = startObservation("idea", {
    input: sanitizeTraceValue(record.input),
    metadata: {
      workflowId: record.id,
      projectId: record.projectId,
      attempt: record.attempt,
    },
  }, { asType: "agent" });
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, "idea");
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, record.userId);
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, record.id);
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [
    "idea",
    `attempt:${record.attempt}`,
  ]);

  return {
    startStage(name, input) {
      turnCount += 1;
      const turn = root.startObservation(`turn-${turnCount}`, {
        metadata: {
          stage: name,
          ...(typeof input === "object" && input !== null ? input : {}),
        },
      }, { asType: "span" });
      return {
        parentSpanContext: turn.otelSpan.spanContext(),
        finish(_output, error) {
          if (error) turn.update({ level: "ERROR", statusMessage: errorMessage(error) });
          turn.end();
        },
      };
    },
    startImage(index, input) {
      const image = root.startObservation(`image-${index}`, {
        metadata: { kind: "image-generation" },
      }, { asType: "span" });
      const call = image.startObservation("llm-call", {
        input: sanitizeTraceValue(input),
      }, { asType: "generation" });
      return {
        parentSpanContext: call.otelSpan.spanContext(),
        finish(output, error, metadata) {
          const model = typeof metadata?.model === "string" ? metadata.model : undefined;
          const callMetadata = metadata ? { ...metadata } : undefined;
          if (callMetadata) delete callMetadata.model;
          call.update({
            output: sanitizeTraceValue(output),
            ...(model ? { model } : {}),
            ...(callMetadata && Object.keys(callMetadata).length ? { metadata: callMetadata } : {}),
            ...(error ? { level: "ERROR", statusMessage: errorMessage(error) } : {}),
          });
          call.end();
          if (error) image.update({ level: "ERROR", statusMessage: errorMessage(error) });
          image.end();
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
