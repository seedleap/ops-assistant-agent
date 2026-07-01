import "dotenv/config";
import { isAbsolute, resolve } from "node:path";

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

function normalizeGoogleVertexEnv(): void {
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentials && !isAbsolute(credentials)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(credentials);
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT_ID;
  if (project) {
    process.env.GOOGLE_CLOUD_PROJECT ||= project;
    process.env.GCLOUD_PROJECT ||= project;
    process.env.GCLOUD_PROJECT_ID ||= project;
  }

  const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GCLOUD_LOCATION;
  if (location) {
    process.env.GOOGLE_CLOUD_LOCATION ||= location;
    process.env.GCLOUD_LOCATION ||= location;
  }

  if (process.env.ASSISTANT_MODEL_PROVIDER === "google-vertex" || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI ||= "true";
  }
}

export interface AppConfig {
  port: number;
  dataDir: string;
  schedulerPollMs: number;
  defaultOutreachSilentMinutes: number;
  interactiveSessionTimeoutMinutes: number;
  assistantDryRun: boolean;
  assistantModelProvider?: string;
  assistantModelId?: string;
  opsDataFile: string;
  loopitDataFile: string;
  skillsDir: string;
  pythonBin: string;
  opsQueryScript: string;
  publicDir: string;
  systemPromptFile: string;
  segmentsFile: string;
  scheduledTasksFile: string;
}

export function loadConfig(): AppConfig {
  normalizeGoogleVertexEnv();
  const dataDir = resolve(process.env.DATA_DIR || "./data");
  return {
    port: numberFromEnv("PORT", 8010),
    dataDir,
    schedulerPollMs: numberFromEnv("SCHEDULER_POLL_MS", 60_000),
    defaultOutreachSilentMinutes: numberFromEnv("DEFAULT_OUTREACH_SILENT_MINUTES", 60),
    interactiveSessionTimeoutMinutes: numberFromEnv("INTERACTIVE_SESSION_TIMEOUT_MINUTES", 60),
    assistantDryRun: boolFromEnv("ASSISTANT_DRY_RUN", false),
    assistantModelProvider: process.env.ASSISTANT_MODEL_PROVIDER || "google-vertex",
    assistantModelId: process.env.ASSISTANT_MODEL_ID || "gemini-3-flash-preview",
    opsDataFile: resolve(process.env.OPS_DATA_FILE || "./sample-data/metrics.json"),
    loopitDataFile: resolve(process.env.LOOPIT_DATA_FILE || "./sample-data/loopit-data.json"),
    skillsDir: resolve(process.env.SKILLS_DIR || "./skills"),
    pythonBin: process.env.PYTHON_BIN || "python3",
    opsQueryScript: resolve(process.env.OPS_QUERY_SCRIPT || "./scripts/ops_query.py"),
    publicDir: resolve(process.env.PUBLIC_DIR || "./public"),
    systemPromptFile: resolve(process.env.SYSTEM_PROMPT_FILE || "./config/system-prompt.md"),
    segmentsFile: resolve(process.env.SEGMENTS_FILE || "./config/user-segments.json"),
    scheduledTasksFile: resolve(process.env.SCHEDULED_TASKS_FILE || "./config/scheduled-tasks.json"),
  };
}
