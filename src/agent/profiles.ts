import type { AppConfig, AgentProfileConfig } from "../config.js";
import type { AssistantRunInput } from "../types.js";

export interface AgentProfile extends AgentProfileConfig {
  id: "creator-chat" | "creator-outreach";
  traceName: "ops-creator-chat" | "ops-creator-outreach";
  toolNames: readonly string[];
  compactionEnabled: boolean;
}

const INTERACTIVE_TOOLS = [
  "query_work_overview",
  "query_creator_works",
  "query_work_profile",
  "query_work_consumption",
  "query_work_comments",
  "query_work_prompt",
  "read_knowledge",
] as const;

const OUTREACH_TOOLS = [
  "query_work_overview",
  "query_creator_works",
  "query_work_profile",
  "query_work_consumption",
  "query_work_comments",
  "read_knowledge",
] as const;

export function resolveAgentProfile(config: AppConfig, input: AssistantRunInput): AgentProfile {
  if (input.type === "outreach") {
    return {
      id: "creator-outreach",
      traceName: "ops-creator-outreach",
      ...config.outreachAgent,
      toolNames: OUTREACH_TOOLS,
      compactionEnabled: false,
    };
  }

  return {
    id: "creator-chat",
    traceName: "ops-creator-chat",
    ...config.interactiveAgent,
    ...(input.model ? { modelId: input.model } : {}),
    toolNames: INTERACTIVE_TOOLS,
    compactionEnabled: true,
  };
}
