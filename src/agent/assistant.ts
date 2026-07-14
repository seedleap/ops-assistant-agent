import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { AssistantRunInput } from "../types.js";
import { disabledObservability, type Observability } from "../observability/index.js";
import { forwardSessionEvent, usageDelta, type AssistantEvent, type AssistantEventHandler } from "./events.js";
import { resolveAgentProfile } from "./profiles.js";
import { OpsSessionFactory } from "./session.js";

interface AssistantMessageLike {
  role?: string;
  content?: Array<{ type?: string; text?: unknown }>;
  stopReason?: string;
  errorMessage?: unknown;
}

export class OpsAssistant {
  private readonly sessions: OpsSessionFactory;

  constructor(
    private readonly config: AppConfig,
    observability: Observability = disabledObservability(),
  ) {
    this.sessions = new OpsSessionFactory(config, observability);
  }

  close(): Promise<void> {
    return this.sessions.close();
  }

  async run(input: AssistantRunInput, emit?: AssistantEventHandler): Promise<string> {
    if (this.config.assistantDryRun) {
      const output = this.dryRun(input);
      emit?.({ type: "text_delta", delta: output });
      return output;
    }

    const profile = resolveAgentProfile(this.config, input);
    const handle = await this.sessions.create(profile, input);
    const { session, trace, modelName } = handle;
    const chunks: string[] = [];
    const before = session.getSessionStats();
    const unsubscribe = session.subscribe((event) => {
      forwardSessionEvent(event, emit);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        chunks.push(String(event.assistantMessageEvent.delta || ""));
      }
      if (event.type === "auto_retry_start") trace?.addTags(["auto-retry"]);
    });

    let output = "";
    let runError: unknown;
    try {
      await this.promptWithTimeout(session, this.buildPrompt(input), profile.timeoutMs);
      const result = this.readLastAssistantMessage(session);
      if (result.error) throw new Error(result.error);
      output = (result.text || chunks.join("")).trim();
      const after = session.getSessionStats();
      emit?.({ type: "usage", usage: usageDelta(before, after, modelName) });
      return output;
    } catch (error) {
      runError = error;
      throw error;
    } finally {
      const stats = session.getSessionStats();
      unsubscribe();
      await trace?.finish(output, stats, runError);
      session.dispose();
    }
  }

  private async promptWithTimeout(session: AgentSession, prompt: string, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void session.abort().finally(() => reject(new Error(`Agent timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
    });
    try {
      await Promise.race([session.prompt(prompt), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private buildPrompt(input: AssistantRunInput): string {
    const uid = input.creatorUid?.trim();
    if (!uid) return input.prompt;
    return `（背景信息，不用复述：当前创作者的 UID 是 ${uid}。当 ta 说“我的作品/我的游戏”等但没给出具体作品链接或 PID 时，用 query_creator_works 查询这个 UID 名下的作品。）\n\n${input.prompt}`;
  }

  private readLastAssistantMessage(session: AgentSession): { text: string; error?: string } {
    const messages = session.messages as AssistantMessageLike[];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return { text: "", error: this.formatAssistantError(message.errorMessage, message.stopReason) };
      }
      return {
        text: Array.isArray(message.content)
          ? message.content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("")
            .trim()
          : "",
      };
    }
    return { text: "" };
  }

  private formatAssistantError(error: unknown, stopReason: string): string {
    const raw = typeof error === "string" && error.trim() ? error : `Assistant stopped with reason: ${stopReason}`;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") return parsed.error.message;
    } catch {
      // Provider error is not JSON; preserve the original message.
    }
    return raw;
  }

  private dryRun(input: AssistantRunInput): string {
    return input.type === "outreach"
      ? `【运营提醒】这是 dry-run 触达消息：${input.prompt.slice(0, 80)}`
      : `【dry-run 回复】已收到：${input.prompt.slice(0, 120)}`;
  }
}

export type { AssistantEvent };
