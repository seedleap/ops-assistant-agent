import type { AgentProfileDefinition } from "./types.js";

const BASE_RUNTIME = {
  maxTurns: 2,
  timeoutMs: 120_000,
  maxRetries: 2,
  compactionEnabled: false,
} as const;

const BASE_MODEL = {
  provider: "azure-openai-responses",
  modelId: "gpt-5.5",
  thinkingLevel: "high",
} as const;

export const IDEA_IMAGE_CONFIG = {
  modelId: "gpt-image-2",
  quality: "low",
  size: "1024x1536",
  background: "opaque",
  outputFormat: "png",
} as const;

export const IDEA_INVENTOR_PROFILE = {
  runType: "interactive",
  traceName: "idea",
  prompt: { version: "idea-workflow-v2", fileName: "idea.md", section: "idea-inventor" },
  model: BASE_MODEL,
  runtime: BASE_RUNTIME,
  toolNames: [],
  localSkills: [],
  skills: [],
} as const satisfies AgentProfileDefinition;

export const IDEA_AUDITOR_PROFILE = {
  runType: "interactive",
  traceName: "idea",
  prompt: { version: "idea-workflow-v2", fileName: "idea.md", section: "idea-auditor" },
  model: BASE_MODEL,
  runtime: BASE_RUNTIME,
  toolNames: [],
  localSkills: [],
  skills: [],
} as const satisfies AgentProfileDefinition;

export const IDEA_CONVERGER_PROFILE = {
  runType: "interactive",
  traceName: "idea",
  prompt: { version: "idea-workflow-v2", fileName: "idea.md", section: "idea-converger" },
  model: BASE_MODEL,
  runtime: BASE_RUNTIME,
  toolNames: [],
  localSkills: [],
  skills: [],
} as const satisfies AgentProfileDefinition;
