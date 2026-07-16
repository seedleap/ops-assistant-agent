import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "./profiles/types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function createModelParametersExtension(profile: AgentProfile): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event) => {
      const payload = asRecord(event.payload);
      if (!payload) return;

      if (profile.model.provider === "google-vertex") {
        const config = asRecord(payload.config) || {};
        const thinkingConfig = asRecord(config.thinkingConfig) || {};
        return {
          ...payload,
          config: {
            ...config,
            temperature: profile.model.temperature,
            thinkingConfig: {
              ...thinkingConfig,
              // Gemini 可以内部思考，但不要把 thought parts 回传并写入会话上下文。
              includeThoughts: false,
            },
          },
        };
      }

      if (profile.model.provider === "openai" || profile.model.provider === "openrouter") {
        return { ...payload, temperature: profile.model.temperature };
      }
    });
  };
}

export function createTurnLimitExtension(profile: AgentProfile): ExtensionFactory {
  return (pi) => {
    pi.on("turn_start", (event, ctx) => {
      if (event.turnIndex < profile.runtime.maxTurns) return;
      ctx.abort();
      throw new Error(`Agent exceeded maxTurns=${profile.runtime.maxTurns}`);
    });
  };
}
