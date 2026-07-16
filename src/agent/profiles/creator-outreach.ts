import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_OUTREACH_PROFILE = {
  runType: "outreach",
  traceName: "ops-creator-outreach",
  prompt: {
    version: "creator-outreach-v2",
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
    "query_work_overview",
    "query_creator_works",
    "query_work_profile",
    "query_work_consumption",
    "query_work_comments",
  ],
  localSkills: ["creator-guide", "ops-activities"],
  skills: [],
} as const satisfies AgentProfileDefinition;
