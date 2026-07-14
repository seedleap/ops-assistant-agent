import type { OpsMcpToolName } from "../../opsMcpClient.js";

export type AgentProfileId = "creator-chat" | "creator-outreach";
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

/** Deploy-time values that may override a Profile's versioned defaults. */
export interface AgentProfileConfig extends AgentModelConfig {
  maxTurns: number;
  timeoutMs: number;
}

/** Versioned behavior owned by one Agent, independent from credentials/deployment. */
export interface AgentProfileDefinition {
  id: AgentProfileId;
  runType: AgentRunType;
  traceName: string;
  promptVersion: string;
  promptFileName: string;
  model: AgentModelConfig;
  runtime: AgentRuntimeConfig;
  toolNames: readonly AgentToolName[];
}

/** Fully resolved Profile passed to the Pi runtime. */
export interface AgentProfile extends Omit<AgentProfileDefinition, "model" | "runtime" | "promptFileName">,
  AgentModelConfig,
  AgentRuntimeConfig {
  systemPromptFile: string;
}
