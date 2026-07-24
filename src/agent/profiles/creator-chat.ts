import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_CHAT_PROFILE = {
  runType: "interactive",
  traceName: "ops-creator-chat",
  prompt: {
    version: "creator-support-v7-time-context",
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
    "query_public_work",
    "analyze_work_comments",
    "query_creator_account_summary",
  ],
  localSkills: ["analyze-project", "summarize-comments", "analyze-account", "search-docs"],
  skills: [],
} as const satisfies AgentProfileDefinition;
