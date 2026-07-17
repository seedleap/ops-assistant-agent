import { CREATOR_CHAT_PROFILE } from "./creator-chat.js";
import { CREATOR_OUTREACH_PROFILE } from "./creator-outreach.js";
import {
  IDEA_CONVERGER_PROFILE,
  IDEA_INVENTOR_PROFILE,
} from "./idea-workflow.js";
import type { AgentProfileDefinition } from "./types.js";

/** The single source of truth for registered Agent Profiles. */
export const AGENT_PROFILES = {
  "creator-chat": CREATOR_CHAT_PROFILE,
  "creator-outreach": CREATOR_OUTREACH_PROFILE,
  "idea-inventor": IDEA_INVENTOR_PROFILE,
  "idea-converger": IDEA_CONVERGER_PROFILE,
} as const satisfies Record<string, AgentProfileDefinition>;

export type AgentProfileId = keyof typeof AGENT_PROFILES;

export const AGENT_PROFILE_IDS = Object.freeze(
  Object.keys(AGENT_PROFILES) as AgentProfileId[],
);

export function isAgentProfileId(value: string): value is AgentProfileId {
  return Object.hasOwn(AGENT_PROFILES, value);
}
