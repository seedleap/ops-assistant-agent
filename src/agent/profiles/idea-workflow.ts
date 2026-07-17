import type { AgentProfileDefinition } from "./types.js";

const BASE_RUNTIME = {
  maxTurns: 2,
  timeoutMs: 120_000,
  maxRetries: 2,
  compactionEnabled: false,
} as const;

const BASE_MODEL = {
  provider: "google-vertex",
  modelId: "gemini-3.1-pro-preview",
  thinkingLevel: "high",
  temperature: 0.7,
} as const;

export const IDEA_INVENTOR_PROFILE = {
  runType: "interactive",
  traceName: "idea",
  prompt: { version: "idea-workflow-v2", fileName: "idea-inventor.md" },
  model: BASE_MODEL,
  runtime: BASE_RUNTIME,
  toolNames: [],
  localSkills: [],
  skills: [],
} as const satisfies AgentProfileDefinition;

export const IDEA_AUDITOR_PROFILE = {
  runType: "interactive",
  traceName: "idea",
  prompt: { version: "idea-workflow-v2", fileName: "idea-auditor.md" },
  model: { ...BASE_MODEL, temperature: 0.2 },
  runtime: BASE_RUNTIME,
  toolNames: [],
  localSkills: [],
  skills: [],
} as const satisfies AgentProfileDefinition;

export const IDEA_CONVERGER_PROFILE = {
  runType: "interactive",
  traceName: "idea",
  prompt: { version: "idea-workflow-v2", fileName: "idea-converger.md" },
  model: { ...BASE_MODEL, temperature: 0.3 },
  runtime: BASE_RUNTIME,
  toolNames: [],
  localSkills: [],
  skills: [],
} as const satisfies AgentProfileDefinition;
