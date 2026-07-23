import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_CHAT_PROFILE = {
  runType: "interactive",
  traceName: "ops-creator-chat",
  prompt: {
    version: "creator-support-v4",
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
    "creator_work_resolve",
    "creator_work_analyze",
    "creator_comments_analyze",
    "creator_public_work_inspect",
    "creator_account_summarize",
    "creator_inspiration_context",
    "creator_catalog_search",
    "creator_activity_status",
  ],
  localSkills: ["creator-analysis", "creator-inspiration", "creator-guide", "ops-activities"],
  skills: [],
} as const satisfies AgentProfileDefinition;
