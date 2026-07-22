import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_CHAT_PROFILE = {
  runType: "interactive",
  traceName: "ops-creator-chat",
  prompt: {
    version: "creator-support-v3",
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
    "query_work_analysis",
    "analyze_work_comments",
    "query_public_work",
    "query_creator_account_summary",
    "query_creator_inspiration_context",
    "search_creation_catalog",
    "query_creator_activity_status",
  ],
  localSkills: ["creator-analysis", "creator-inspiration", "creator-guide", "ops-activities"],
  skills: [],
} as const satisfies AgentProfileDefinition;
