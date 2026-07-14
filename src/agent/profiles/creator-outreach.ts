import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_OUTREACH_PROFILE = {
  id: "creator-outreach",
  runType: "outreach",
  traceName: "ops-creator-outreach",
  promptVersion: "creator-outreach-v1",
  promptFileName: "creator-outreach.md",
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
    "query_work_overview",
    "query_creator_works",
    "query_work_profile",
    "query_work_consumption",
    "query_work_comments",
    "read_knowledge",
  ],
} as const satisfies AgentProfileDefinition;
