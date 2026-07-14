import "dotenv/config";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high"]);
const optionalString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);
const booleanString = (fallback: boolean) => z.preprocess((value) => {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return value;
}, z.boolean());
const positiveNumber = (fallback: number) => z.coerce.number().positive().default(fallback);
const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const nonNegativeInteger = (fallback: number) => z.coerce.number().int().min(0).default(fallback);
const nonNegativeNumber = (fallback: number) => z.coerce.number().min(0).default(fallback);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_010),
  CORS_ORIGINS: z.string().trim().min(1).default("*"),
  TRUST_PROXY_HOPS: nonNegativeInteger(0),
  STATIC_UI_ENABLED: booleanString(true),
  API_AUTH_MODE: z.enum(["none", "jwt"]).optional(),
  API_JWT_SECRET: optionalString,
  API_JWT_ISSUER: optionalString,
  API_JWT_AUDIENCE: optionalString,
  RATE_LIMIT_WINDOW_MS: positiveInteger(60_000),
  RATE_LIMIT_MAX: positiveInteger(120),
  DATA_DIR: z.string().trim().min(1).default("./data"),
  SCHEDULER_ENABLED: booleanString(true),
  SCHEDULER_POLL_MS: positiveInteger(60_000),
  DEFAULT_OUTREACH_SILENT_MINUTES: nonNegativeNumber(60),
  INTERACTIVE_SESSION_TIMEOUT_MINUTES: positiveNumber(60),

  ASSISTANT_DRY_RUN: booleanString(false),
  ASSISTANT_MODEL_PROVIDER: z.string().trim().min(1).default("google-vertex"),
  ASSISTANT_MODEL_ID: z.string().trim().min(1).default("gemini-3-flash-preview"),
  ASSISTANT_THINKING_LEVEL: thinkingLevelSchema.default("low"),
  ASSISTANT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  ASSISTANT_MAX_TURNS: positiveInteger(10),
  ASSISTANT_TIMEOUT_MS: positiveInteger(120_000),

  OUTREACH_MODEL_PROVIDER: optionalString,
  OUTREACH_MODEL_ID: optionalString,
  OUTREACH_THINKING_LEVEL: thinkingLevelSchema.default("off"),
  OUTREACH_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  OUTREACH_MAX_TURNS: positiveInteger(6),
  OUTREACH_TIMEOUT_MS: positiveInteger(90_000),
  MODEL_WHITELIST: optionalString,

  LANGFUSE_ENABLED: booleanString(false),
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  LANGFUSE_BASE_URL: optionalString,
  LANGFUSE_TRACING_ENVIRONMENT: optionalString,
  LANGFUSE_RELEASE: optionalString,

  LOOPIT_DATA_FILE: z.string().trim().min(1).default("./sample-data/loopit-data.json"),
  SKILLS_DIR: z.string().trim().min(1).default("./skills"),
  OPS_MCP_URL: optionalString.pipe(z.string().url().optional()),
  OPS_MCP_TOKEN: optionalString,
  OPS_MCP_TIMEOUT_MS: positiveInteger(120_000),
  OPS_MCP_MAX_RESPONSE_BYTES: positiveInteger(2 * 1024 * 1024),
  PUBLIC_DIR: z.string().trim().min(1).default("./public"),
  SYSTEM_PROMPT_FILE: z.string().trim().min(1).default("./config/system-prompt.md"),
  SEGMENTS_FILE: z.string().trim().min(1).default("./config/user-segments.json"),
  SCHEDULED_TASKS_FILE: z.string().trim().min(1).default("./config/scheduled-tasks.json"),
}).superRefine((env, ctx) => {
  if (env.LANGFUSE_ENABLED && (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["LANGFUSE_ENABLED"],
      message: "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required when tracing is enabled",
    });
  }
  if (env.NODE_ENV === "production" && !env.ASSISTANT_DRY_RUN && !env.OPS_MCP_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPS_MCP_URL"],
      message: "OPS_MCP_URL is required in production unless ASSISTANT_DRY_RUN=true",
    });
  }
});

export type AgentThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export interface AgentProfileConfig {
  provider: string;
  modelId: string;
  thinkingLevel: AgentThinkingLevel;
  temperature: number;
  maxTurns: number;
  timeoutMs: number;
}

export interface LangfuseConfig {
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment: string;
  release?: string;
}

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  host: string;
  port: number;
  corsOrigins: "*" | string[];
  trustProxyHops: number;
  staticUiEnabled: boolean;
  auth: {
    mode: "none" | "jwt";
    jwtSecret?: string;
    issuer?: string;
    audience?: string;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  dataDir: string;
  schedulerEnabled: boolean;
  schedulerPollMs: number;
  defaultOutreachSilentMinutes: number;
  interactiveSessionTimeoutMinutes: number;
  assistantDryRun: boolean;
  modelWhitelist: string[];
  interactiveAgent: AgentProfileConfig;
  outreachAgent: AgentProfileConfig;
  langfuse: LangfuseConfig;
  loopitDataFile: string;
  skillsDir: string;
  opsMcp: {
    url?: string;
    token?: string;
    timeoutMs: number;
    maxResponseBytes: number;
  };
  publicDir: string;
  systemPromptFile: string;
  segmentsFile: string;
  scheduledTasksFile: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

function parseModelWhitelist(raw: string | undefined, defaults: string[]): string[] {
  if (!raw) return [...new Set(defaults)];
  const entries = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  if (entries.length === 0) throw new ConfigError(["MODEL_WHITELIST must contain at least one provider/model-id"]);
  return entries;
}

function parseCorsOrigins(raw: string): "*" | string[] {
  if (raw === "*") return "*";
  const origins = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  if (origins.length === 0) throw new ConfigError(["CORS_ORIGINS must be * or a comma-separated origin list"]);
  for (const origin of origins) {
    try {
      new URL(origin);
    } catch {
      throw new ConfigError([`CORS_ORIGINS contains an invalid origin: ${origin}`]);
    }
  }
  return origins;
}

function normalizeGoogleVertexEnv(provider: string): void {
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentials && !isAbsolute(credentials)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(credentials);
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT_ID;
  if (project) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    process.env.GOOGLE_CLOUD_PROJECT ||= project;
    process.env.GCLOUD_PROJECT ||= project;
    process.env.GCLOUD_PROJECT_ID ||= project;
  }
  const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GCLOUD_LOCATION;
  if (location) {
    process.env.GOOGLE_CLOUD_LOCATION ||= location;
    process.env.GCLOUD_LOCATION ||= location;
  }
  if (provider === "google-vertex" || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI ||= "true";
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const env = parsed.data;
  const authMode = env.API_AUTH_MODE || (env.NODE_ENV === "production" ? "jwt" : "none");
  if (authMode === "jwt" && !env.API_JWT_SECRET) {
    throw new ConfigError(["API_JWT_SECRET is required when API_AUTH_MODE=jwt"]);
  }
  if (authMode === "jwt" && env.API_JWT_SECRET && env.API_JWT_SECRET.length < 32) {
    throw new ConfigError(["API_JWT_SECRET must contain at least 32 characters"]);
  }
  const outreachProvider = env.OUTREACH_MODEL_PROVIDER || env.ASSISTANT_MODEL_PROVIDER;
  const outreachModelId = env.OUTREACH_MODEL_ID || env.ASSISTANT_MODEL_ID;
  const interactiveModel = `${env.ASSISTANT_MODEL_PROVIDER}/${env.ASSISTANT_MODEL_ID}`;
  const outreachModel = `${outreachProvider}/${outreachModelId}`;
  const modelWhitelist = parseModelWhitelist(env.MODEL_WHITELIST, [
    interactiveModel,
    outreachModel,
    "google-vertex/gemini-3.1-flash-lite",
  ]);
  const missingModels = [interactiveModel, outreachModel].filter((model) => !modelWhitelist.includes(model));
  if (missingModels.length > 0) {
    throw new ConfigError(missingModels.map((model) => `MODEL_WHITELIST does not allow configured model ${model}`));
  }

  if (environment === process.env) normalizeGoogleVertexEnv(env.ASSISTANT_MODEL_PROVIDER);

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    host: env.HOST,
    port: env.PORT,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    trustProxyHops: env.TRUST_PROXY_HOPS,
    staticUiEnabled: env.STATIC_UI_ENABLED,
    auth: {
      mode: authMode,
      jwtSecret: env.API_JWT_SECRET,
      issuer: env.API_JWT_ISSUER,
      audience: env.API_JWT_AUDIENCE,
    },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
    },
    dataDir: resolve(env.DATA_DIR),
    schedulerEnabled: env.SCHEDULER_ENABLED,
    schedulerPollMs: env.SCHEDULER_POLL_MS,
    defaultOutreachSilentMinutes: env.DEFAULT_OUTREACH_SILENT_MINUTES,
    interactiveSessionTimeoutMinutes: env.INTERACTIVE_SESSION_TIMEOUT_MINUTES,
    assistantDryRun: env.ASSISTANT_DRY_RUN,
    modelWhitelist,
    interactiveAgent: {
      provider: env.ASSISTANT_MODEL_PROVIDER,
      modelId: env.ASSISTANT_MODEL_ID,
      thinkingLevel: env.ASSISTANT_THINKING_LEVEL,
      temperature: env.ASSISTANT_TEMPERATURE,
      maxTurns: env.ASSISTANT_MAX_TURNS,
      timeoutMs: env.ASSISTANT_TIMEOUT_MS,
    },
    outreachAgent: {
      provider: outreachProvider,
      modelId: outreachModelId,
      thinkingLevel: env.OUTREACH_THINKING_LEVEL,
      temperature: env.OUTREACH_TEMPERATURE,
      maxTurns: env.OUTREACH_MAX_TURNS,
      timeoutMs: env.OUTREACH_TIMEOUT_MS,
    },
    langfuse: {
      enabled: env.LANGFUSE_ENABLED,
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
      environment: env.LANGFUSE_TRACING_ENVIRONMENT || env.NODE_ENV,
      release: env.LANGFUSE_RELEASE,
    },
    loopitDataFile: resolve(env.LOOPIT_DATA_FILE),
    skillsDir: resolve(env.SKILLS_DIR),
    opsMcp: {
      url: env.OPS_MCP_URL,
      token: env.OPS_MCP_TOKEN,
      timeoutMs: env.OPS_MCP_TIMEOUT_MS,
      maxResponseBytes: env.OPS_MCP_MAX_RESPONSE_BYTES,
    },
    publicDir: resolve(env.PUBLIC_DIR),
    systemPromptFile: resolve(env.SYSTEM_PROMPT_FILE),
    segmentsFile: resolve(env.SEGMENTS_FILE),
    scheduledTasksFile: resolve(env.SCHEDULED_TASKS_FILE),
  };
}
