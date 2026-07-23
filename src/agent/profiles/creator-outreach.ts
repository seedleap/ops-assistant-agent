import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_OUTREACH_PROFILE = {
  runType: "outreach",
  traceName: "ops-creator-outreach",
  prompt: {
    version: "creator-outreach-v4",
    fileName: "creator-outreach.md",
  },
  model: {
    provider: "google-vertex",
    modelId: "gemini-3-flash-preview",
    thinkingLevel: "off",
    temperature: 0.2,
  },
  runtime: {
    maxTurns: 6,
    timeoutMs: 90_000,
    maxRetries: 2,
    compactionEnabled: false,
  },
  toolNames: [
    "read",
    "creator_work_resolve",
    "creator_work_analyze",
    "creator_comments_analyze",
    "creator_account_summarize",
    "creator_inspiration_context",
    "creator_catalog_search",
    "creator_activity_status",
  ],
  localSkills: ["creator-analysis", "creator-inspiration", "creator-guide", "ops-activities"],
  skills: [],
} as const satisfies AgentProfileDefinition;
