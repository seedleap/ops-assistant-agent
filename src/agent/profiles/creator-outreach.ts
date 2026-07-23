import type { AgentProfileDefinition } from "./types.js";

export const CREATOR_OUTREACH_PROFILE = {
  runType: "outreach",
  traceName: "ops-creator-outreach",
  prompt: {
    version: "creator-outreach-v5-rpd4291",
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
    "creator_activity_status",
  ],
  localSkills: ["ops-activities"],
  skills: [],
} as const satisfies AgentProfileDefinition;
