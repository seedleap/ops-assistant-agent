import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "./profiles.js";

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

      if (profile.provider === "google-vertex") {
        const config = asRecord(payload.config) || {};
        const thinkingConfig = asRecord(config.thinkingConfig) || {};
        return {
          ...payload,
          config: {
            ...config,
            temperature: profile.temperature,
            thinkingConfig: {
              ...thinkingConfig,
              includeThoughts: false,
            },
          },
        };
      }

      if (profile.provider === "openai" || profile.provider === "openrouter") {
        return { ...payload, temperature: profile.temperature };
      }
    });
  };
}

export function createTurnLimitExtension(profile: AgentProfile): ExtensionFactory {
  return (pi) => {
    pi.on("turn_start", (event, ctx) => {
      if (event.turnIndex < profile.maxTurns) return;
      ctx.abort();
      throw new Error(`Agent exceeded maxTurns=${profile.maxTurns}`);
    });
  };
}
