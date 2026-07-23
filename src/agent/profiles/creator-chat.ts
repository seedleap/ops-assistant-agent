import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_CHAT_PROFILE = {
  runType: "interactive",
  traceName: "ops-creator-chat",
  prompt: {
    version: "creator-support-v5-rpd4291",
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
    "creator_project_analyze",
    "creator_comments_analyze",
    "creator_account_summarize",
  ],
  localSkills: ["creator-analysis", "creator-guide"],
  skills: [],
} as const satisfies AgentProfileDefinition;
