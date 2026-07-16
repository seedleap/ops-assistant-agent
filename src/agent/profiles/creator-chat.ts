import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_CHAT_PROFILE = {
  runType: "interactive",
  traceName: "ops-creator-chat",
  prompt: {
    version: "creator-growth-v2",
    fileName: "creator-chat.md",
  },
  model: {
    provider: "google-vertex",
    modelId: "gemini-3-flash-preview",
    thinkingLevel: "low",
    temperature: 0.3,
  },
  runtime: {
    maxTurns: 10,
    timeoutMs: 120_000,
    maxRetries: 2,
    compactionEnabled: true,
  },
  toolNames: [
    "read",
    "query_work_overview",
    "query_creator_works",
    "query_work_profile",
    "query_work_consumption",
    "query_work_comments",
    "query_work_prompt",
    "read_knowledge",
  ],
  localSkills: ["creator-guide", "ops-activities"],
  skills: [],
} as const satisfies AgentProfileDefinition;
