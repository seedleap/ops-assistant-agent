import { join } from "node:path";
import type { AppConfig } from "../../config.js";
import type { AssistantRunInput } from "../../types.js";
import { CREATOR_CHAT_PROFILE } from "./creator-chat.js";
import { CREATOR_OUTREACH_PROFILE } from "./creator-outreach.js";
import type {
  AgentProfile,
  AgentProfileConfig,
  AgentProfileDefinition,
  AgentProfileId,
} from "./types.js";

export const AGENT_PROFILE_DEFINITIONS = [
  CREATOR_CHAT_PROFILE,
  CREATOR_OUTREACH_PROFILE,
] as const;

function definitionById(id: AgentProfileId): AgentProfileDefinition {
  const definition = AGENT_PROFILE_DEFINITIONS.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown Agent Profile: ${id}`);
  return definition;
}

export function resolveAgentProfileById(
  config: AppConfig,
  id: AgentProfileId,
  modelIdOverride?: string,
): AgentProfile {
  const definition = definitionById(id);
  const configured: AgentProfileConfig = id === "creator-chat"
    ? config.agentProfiles.creatorChat
    : config.agentProfiles.creatorOutreach;
  return {
    id: definition.id,
    runType: definition.runType,
    traceName: definition.traceName,
    promptVersion: definition.promptVersion,
    toolNames: definition.toolNames,
    ...definition.runtime,
    ...configured,
    ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
    systemPromptFile: join(config.agentPromptsDir, definition.promptFileName),
  };
}

export function resolveAgentProfile(config: AppConfig, input: AssistantRunInput): AgentProfile {
  return input.type === "outreach"
    ? resolveAgentProfileById(config, "creator-outreach")
    : resolveAgentProfileById(config, "creator-chat", input.model);
}

export function listAgentProfiles(config: AppConfig): AgentProfile[] {
  return AGENT_PROFILE_DEFINITIONS.map((definition) => resolveAgentProfileById(config, definition.id));
}
