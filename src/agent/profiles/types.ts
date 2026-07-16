import type { OpsMcpToolName } from "../../integrations/loopit/mcp-client.js";

export type AgentRunType = "interactive" | "outreach";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
export type AgentToolName = OpsMcpToolName | "read_knowledge";

export interface AgentModelConfig {
  provider: string;
  modelId: string;
  thinkingLevel: AgentThinkingLevel;
  temperature: number;
}

export interface AgentRuntimeConfig {
  maxTurns: number;
  timeoutMs: number;
  maxRetries: number;
  compactionEnabled: boolean;
}

export interface AgentPromptConfig {
  version: string;
  fileName: string;
}

/** Optional deploy-time changes layered over a Profile's versioned defaults. */
export interface AgentProfileOverrides {
  model?: Partial<AgentModelConfig>;
  runtime?: Partial<Pick<AgentRuntimeConfig, "maxTurns" | "timeoutMs">>;
}

/** Versioned behavior owned by one Agent, independent from credentials/deployment. */
export interface AgentProfileDefinition {
  runType: AgentRunType;
  traceName: string;
  prompt: AgentPromptConfig;
  model: AgentModelConfig;
  runtime: AgentRuntimeConfig;
  toolNames: readonly AgentToolName[];
}

/** Fully resolved Profile passed to the Pi runtime. */
export interface AgentProfile<Id extends string = string> extends Omit<AgentProfileDefinition, "prompt"> {
  id: Id;
  prompt: AgentPromptConfig & { file: string };
}
