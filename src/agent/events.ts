import type {
  AgentSessionEvent,
  SessionStats,
} from "@earendil-works/pi-coding-agent";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  model?: string;
}

export interface AssistantEvent {
  type: "text_delta" | "tool_start" | "tool_end" | "usage";
  delta?: string;
  tool?: string;
  ok?: boolean;
  usage?: TurnUsage;
}

export type AssistantEventHandler = (event: AssistantEvent) => void;

export function forwardSessionEvent(event: AgentSessionEvent, emit?: AssistantEventHandler): void {
  if (!emit) return;
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    emit({ type: "text_delta", delta: String(event.assistantMessageEvent.delta || "") });
    return;
  }
  if (event.type === "tool_execution_start") {
    emit({ type: "tool_start", tool: event.toolName });
    return;
  }
  if (event.type === "tool_execution_end") {
    emit({ type: "tool_end", tool: event.toolName, ok: !event.isError });
  }
}

export function usageDelta(before: SessionStats, after: SessionStats, model?: string): TurnUsage {
  const delta = (key: keyof SessionStats["tokens"]) => Math.max(0, after.tokens[key] - before.tokens[key]);
  const inputTokens = delta("input");
  const outputTokens = delta("output");
  const cacheReadTokens = delta("cacheRead");
  const cacheWriteTokens = delta("cacheWrite");
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: delta("total") || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: Math.max(0, after.cost - before.cost),
    model,
  };
}
