import {
  LangfuseOtelSpanAttributes,
  startObservation,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseTool,
} from "@langfuse/tracing";
import type {
  ExtensionFactory,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "../agent/profiles/types.js";
import type { AssistantRunInput } from "../domain/types.js";
import type { Observability } from "./index.js";
import { errorMessage, sanitizeTraceValue } from "./sanitize.js";

interface AssistantMessageLike {
  role?: string;
  content?: Array<{ type?: string; text?: unknown }>;
  model?: string;
  stopReason?: string;
  errorMessage?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
}

function assistantText(message: AssistantMessageLike | undefined): string {
  // 只记录可见文本；Gemini 的思考过程不能进入 trace 输出或后续上下文。
  if (!message || !Array.isArray(message.content)) return "";
  const text = message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
  return stripJsonFence(text);
}

export function stripJsonFence(text: string): string {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) return text;
  const json = match[1].trim();
  try {
    JSON.parse(json);
    return json;
  } catch {
    return text;
  }
}

function toolOutput(result: unknown): unknown {
  const payload = result as { content?: Array<{ type?: string; text?: unknown }> } | undefined;
  if (!Array.isArray(payload?.content)) return sanitizeTraceValue(result);
  return sanitizeTraceValue(payload.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n"));
}

export interface AgentRunTrace {
  extension: ExtensionFactory;
  finish(output: string, stats?: SessionStats, error?: unknown): Promise<void>;
  addTags(tags: string[]): void;
}

export function createAgentRunTrace(
  observability: Observability,
  profile: AgentProfile,
  input: AssistantRunInput,
  promptHash: string,
): AgentRunTrace | undefined {
  if (!observability.enabled) return undefined;

  const tags = new Set<string>([
    input.type,
    profile.id,
    profile.model.modelId,
    `prompt:${profile.prompt.version}`,
    `prompt-sha256:${promptHash}`,
    ...(input.traceContext ? [
      `workflow:${input.traceContext.workflowId}`,
      `workflow-stage:${input.traceContext.stage}`,
      `workflow-attempt:${input.traceContext.attempt}`,
    ] : []),
  ]);
  const parentSpanContext = input.traceContext?.parentSpanContext;
  const root = parentSpanContext ? undefined : startObservation(profile.traceName, {
    input: sanitizeTraceValue(input.prompt),
    metadata: {
      runId: input.runId,
      runType: input.type,
      promptVersion: profile.prompt.version,
      promptHash,
      modelProvider: profile.model.provider,
      modelId: profile.model.modelId,
      thinkingLevel: profile.model.thinkingLevel,
      ...(profile.model.temperature !== undefined ? { temperature: profile.model.temperature } : {}),
      maxTurns: profile.runtime.maxTurns,
    },
  }, { asType: "agent" });
  if (root) {
    root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, profile.traceName);
    root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, input.userId);
    root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, input.imThreadId);
    root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [...tags]);
  }

  let currentTurn: LangfuseGeneration | undefined;
  const toolSpans = new Map<string, LangfuseTool>();

  const extension: ExtensionFactory = (pi) => {
    pi.on("turn_start", (event) => {
      currentTurn?.end();
      const attributes = {
        input: sanitizeTraceValue(input.prompt),
        model: profile.model.modelId,
        modelParameters: {
          ...(profile.model.temperature !== undefined ? { temperature: profile.model.temperature } : {}),
          thinkingLevel: profile.model.thinkingLevel,
        },
      };
      currentTurn = parentSpanContext
        ? startObservation("llm-call", attributes, { asType: "generation", parentSpanContext })
        : root!.startObservation(`turn-${event.turnIndex + 1}`, attributes, { asType: "generation" });
    });

    pi.on("turn_end", (event) => {
      const message = event.message as AssistantMessageLike;
      if (!currentTurn) return;
      const usage = message.usage;
      currentTurn.update({
        output: sanitizeTraceValue(assistantText(message)),
        model: message.model || profile.model.modelId,
        ...(usage ? {
          usageDetails: {
            input: Number(usage.input || 0),
            output: Number(usage.output || 0),
            cacheRead: Number(usage.cacheRead || 0),
            cacheWrite: Number(usage.cacheWrite || 0),
            cacheHitRate: (() => {
              const promptTokens = Number(usage.input || 0) + Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0);
              return promptTokens > 0 ? Number(usage.cacheRead || 0) / promptTokens : 0;
            })(),
            total: Number(usage.totalTokens || 0),
          },
          costDetails: { total: Number(usage.cost?.total || 0) },
        } : {}),
        ...(message.stopReason === "error" || message.stopReason === "aborted"
          ? { level: "ERROR", statusMessage: errorMessage(message.errorMessage || message.stopReason) }
          : {}),
      });
      currentTurn.end();
      currentTurn = undefined;
    });

    pi.on("tool_execution_start", (event) => {
      const parent = currentTurn || root;
      if (!parent) return;
      toolSpans.set(event.toolCallId, parent.startObservation(event.toolName, {
        input: sanitizeTraceValue(event.args),
      }, { asType: "tool" }));
    });

    pi.on("tool_execution_end", (event) => {
      const span = toolSpans.get(event.toolCallId);
      if (!span) return;
      const details = event.result?.details as { error?: unknown } | undefined;
      span.update({
        output: toolOutput(event.result),
        ...(event.isError || event.result?.isError
          ? {
              level: "ERROR",
              statusMessage: errorMessage(details?.error || toolOutput(event.result) || "tool execution error"),
            }
          : {}),
      });
      span.end();
      toolSpans.delete(event.toolCallId);
    });
  };

  return {
    extension,
    addTags(nextTags) {
      nextTags.filter(Boolean).forEach((tag) => tags.add(tag));
      root?.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [...tags]);
    },
    async finish(output, stats, error) {
      currentTurn?.end();
      for (const span of toolSpans.values()) span.end();
      toolSpans.clear();
      if (error) tags.add("failed");
      else if (/^NO_OUTREACH:/i.test(output.trim())) tags.add("no-outreach");
      else tags.add("success");
      if (root) {
        root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [...tags]);
        root.update({
          output: sanitizeTraceValue(output),
          metadata: {
            promptVersion: profile.prompt.version,
            promptHash,
            ...(stats ? {
              inputTokens: stats.tokens.input,
              outputTokens: stats.tokens.output,
              cacheReadTokens: stats.tokens.cacheRead,
              cacheWriteTokens: stats.tokens.cacheWrite,
              cacheHitRate: (() => {
                const promptTokens = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
                return promptTokens > 0 ? stats.tokens.cacheRead / promptTokens : 0;
              })(),
              totalTokens: stats.tokens.total,
              costUsd: stats.cost,
              toolCalls: stats.toolCalls,
            } : {}),
            ...(error ? { error: errorMessage(error) } : {}),
          },
          ...(error ? { level: "ERROR", statusMessage: errorMessage(error) } : {}),
        });
        root.end();
      }
    },
  };
}
