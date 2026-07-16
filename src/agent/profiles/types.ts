import type { OpsMcpToolName } from "../../integrations/loopit/mcp-client.js";
import type { RemoteSkillRef } from "../../integrations/skills/types.js";

export type AgentRunType = "interactive" | "outreach";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
/** Pi 内置只读工具；远程 Skill 物料化到会话目录后由它读取。 */
export type AgentToolName = OpsMcpToolName | "read";

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
  /** 本地随镜像发布的默认 Skill 名称；运行时按 Profile 复制到 .pi/skills。 */
  localSkills?: readonly string[];
  /** 远程维护的业务 Skill 版本；运行时按版本物料化，不从仓库目录读取。 */
  skills?: readonly RemoteSkillRef[];
}

/** Fully resolved Profile passed to the Pi runtime. */
export interface AgentProfile<Id extends string = string> extends Omit<AgentProfileDefinition, "prompt"> {
  id: Id;
  prompt: AgentPromptConfig & { file: string };
}
