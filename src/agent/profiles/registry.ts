import { join } from "node:path";
import type { AppConfig } from "../../config.js";
import type { AssistantRunInput } from "../../types.js";
import {
  AGENT_PROFILES,
  AGENT_PROFILE_IDS,
  type AgentProfileId,
} from "./catalog.js";
import type { AgentProfile } from "./types.js";

const PROFILE_BY_RUN_TYPE = {
  interactive: "creator-chat",
  outreach: "creator-outreach",
} as const satisfies Record<AssistantRunInput["type"], AgentProfileId>;

export function resolveAgentProfileById(
  config: AppConfig,
  id: AgentProfileId,
  modelIdOverride?: string,
): AgentProfile<AgentProfileId> {
  const definition = AGENT_PROFILES[id];
  const overrides = config.agentProfileOverrides[id];
  return {
    ...definition,
    id,
    prompt: {
      ...definition.prompt,
      file: join(config.agentPromptsDir, definition.prompt.fileName),
    },
    model: {
      ...definition.model,
      ...overrides?.model,
      ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
    },
    runtime: {
      ...definition.runtime,
      ...overrides?.runtime,
    },
  };
}

export function resolveAgentProfile(config: AppConfig, input: AssistantRunInput): AgentProfile {
  const id = PROFILE_BY_RUN_TYPE[input.type];
  return resolveAgentProfileById(config, id, input.type === "interactive" ? input.model : undefined);
}

export function listAgentProfiles(config: AppConfig): AgentProfile[] {
  return AGENT_PROFILE_IDS.map((id) => resolveAgentProfileById(config, id));
}
