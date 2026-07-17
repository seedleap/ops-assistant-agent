import "dotenv/config";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { AGENT_PROFILES, type AgentProfileId } from "./agent/profiles/catalog.js";
import type { AgentProfileOverrides } from "./agent/profiles/types.js";

const CREATOR_CHAT_PROFILE = AGENT_PROFILES["creator-chat"];
const CREATOR_OUTREACH_PROFILE = AGENT_PROFILES["creator-outreach"];
const IDEA_INVENTOR_PROFILE = AGENT_PROFILES["idea-inventor"];

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
  ASSISTANT_MODEL_PROVIDER: z.string().trim().min(1).default(CREATOR_CHAT_PROFILE.model.provider),
  ASSISTANT_MODEL_ID: z.string().trim().min(1).default(CREATOR_CHAT_PROFILE.model.modelId),
  ASSISTANT_THINKING_LEVEL: thinkingLevelSchema.default(CREATOR_CHAT_PROFILE.model.thinkingLevel),
  ASSISTANT_TEMPERATURE: z.coerce.number().min(0).max(2).default(CREATOR_CHAT_PROFILE.model.temperature),
  ASSISTANT_MAX_TURNS: positiveInteger(CREATOR_CHAT_PROFILE.runtime.maxTurns),
  ASSISTANT_TIMEOUT_MS: positiveInteger(CREATOR_CHAT_PROFILE.runtime.timeoutMs),

  IDEA_MODEL_PROVIDER: optionalString,
  IDEA_MODEL_ID: optionalString,
  IDEA_THINKING_LEVEL: thinkingLevelSchema.default(IDEA_INVENTOR_PROFILE.model.thinkingLevel),
  IDEA_TIMEOUT_MS: positiveInteger(IDEA_INVENTOR_PROFILE.runtime.timeoutMs),

  IDEA_IMAGE_BASE_URL: optionalString.pipe(z.string().url().optional()),
  IDEA_IMAGE_API_KEY: optionalString,
  IDEA_IMAGE_MODEL: optionalString,
  IDEA_IMAGE_QUALITY: z.enum(["low", "medium", "high"]).default("low"),
  IDEA_IMAGE_TIMEOUT_MS: positiveInteger(90_000),
  IDEA_ASSET_STORAGE: z.enum(["local", "s3"]).optional(),
  USER_PUBLIC_IMAGES_BUCKET: optionalString,
  AZURE_IMAGE_BASE_URL: optionalString.pipe(z.string().url().optional()),
  AZURE_IMAGE_API_KEY: optionalString,
  AZURE_IMAGE_DEPLOYMENT: optionalString,

  OUTREACH_MODEL_PROVIDER: optionalString,
  OUTREACH_MODEL_ID: optionalString,
  OUTREACH_THINKING_LEVEL: thinkingLevelSchema.default(CREATOR_OUTREACH_PROFILE.model.thinkingLevel),
  OUTREACH_TEMPERATURE: z.coerce.number().min(0).max(2).default(CREATOR_OUTREACH_PROFILE.model.temperature),
  OUTREACH_MAX_TURNS: positiveInteger(CREATOR_OUTREACH_PROFILE.runtime.maxTurns),
  OUTREACH_TIMEOUT_MS: positiveInteger(CREATOR_OUTREACH_PROFILE.runtime.timeoutMs),
  MODEL_WHITELIST: optionalString,

  LANGFUSE_ENABLED: booleanString(false),
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  LANGFUSE_BASE_URL: optionalString,
  LANGFUSE_TRACING_ENVIRONMENT: optionalString,
  LANGFUSE_RELEASE: optionalString,

  LOOPIT_DATA_FILE: z.string().trim().min(1).default("./sample-data/loopit-data.json"),
  SKILLS_DIR: z.string().trim().min(1).default("./skills"),
  REMOTE_SKILLS_ENABLED: booleanString(false),
  SKILL_S3_BUCKET: optionalString,
  SKILL_S3_PREFIX: z.string().trim().min(1).default("skills"),
  SKILL_CACHE_DIR: z.string().trim().min(1).default("./data/skill-cache"),
  SKILL_FETCH_TIMEOUT_MS: positiveInteger(120_000),
  SKILL_MAX_BYTES: positiveInteger(20 * 1024 * 1024),
  CONVERSATION_ARCHIVE_ENABLED: booleanString(false),
  CONVERSATION_ARCHIVE_BUCKET: optionalString,
  CONVERSATION_ARCHIVE_PREFIX: z.string().trim().min(1).default("ops-conversations"),
  OPS_MCP_URL: optionalString.pipe(z.string().url().optional()),
  OPS_MCP_TOKEN: optionalString,
  OPS_MCP_TIMEOUT_MS: positiveInteger(120_000),
  OPS_MCP_MAX_RESPONSE_BYTES: positiveInteger(2 * 1024 * 1024),
  PUBLIC_DIR: z.string().trim().min(1).default("./public"),
  AGENT_PROMPTS_DIR: z.string().trim().min(1).default("./config/agent-profiles"),
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

export type { AgentThinkingLevel } from "./agent/profiles/types.js";

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
  ideaImage: {
    baseUrl?: string;
    apiKey?: string;
    model: string;
    quality: "low" | "medium" | "high";
    timeoutMs: number;
  };
  ideaAssets: {
    storage: "local" | "s3";
    bucket: string;
    prefix: string;
    cdnBaseUrl: string;
  };
  modelWhitelist: string[];
  agentProfileOverrides: Partial<Record<AgentProfileId, AgentProfileOverrides>>;
  langfuse: LangfuseConfig;
  loopitDataFile: string;
  skillsDir: string;
  remoteSkills?: {
    enabled: boolean;
    bucket?: string;
    prefix: string;
    cacheDir: string;
    timeoutMs: number;
    maxBytes: number;
  };
  conversationArchive?: {
    enabled: boolean;
    bucket?: string;
    prefix: string;
  };
  opsMcp: {
    url?: string;
    token?: string;
    timeoutMs: number;
    maxResponseBytes: number;
  };
  publicDir: string;
  agentPromptsDir: string;
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
  // Pi's Vertex ADC resolver requires an explicit location even though Vertex
  // itself accepts `global` for Gemini. Keep both common env names aligned.
  const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GCLOUD_LOCATION ||
    (provider === "google-vertex" ? "global" : undefined);
  if (location) {
    process.env.GOOGLE_CLOUD_LOCATION ||= location;
    process.env.GCLOUD_LOCATION ||= location;
  }
  if (provider === "google-vertex" || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI ||= "true";
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  /*
   * 所有环境变量必须在进程启动时完成解析和约束检查。
   * 生产环境的鉴权、CORS 和静态页面策略不能依赖调用方记得正确配置。
   */
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const env = parsed.data;
  const authMode = env.API_AUTH_MODE || (env.NODE_ENV === "production" ? "jwt" : "none");
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);
  if (env.NODE_ENV === "production" && authMode !== "jwt") {
    throw new ConfigError(["production requires API_AUTH_MODE=jwt"]);
  }
  if (env.NODE_ENV === "production" && env.STATIC_UI_ENABLED) {
    throw new ConfigError(["STATIC_UI_ENABLED must be false in production"]);
  }
  if (env.NODE_ENV === "production" && corsOrigins === "*") {
    throw new ConfigError(["CORS_ORIGINS must be an explicit origin list in production"]);
  }
  if (authMode === "jwt" && !env.API_JWT_SECRET) {
    throw new ConfigError(["API_JWT_SECRET is required when API_AUTH_MODE=jwt"]);
  }
  if (authMode === "jwt" && env.API_JWT_SECRET && env.API_JWT_SECRET.length < 32) {
    throw new ConfigError(["API_JWT_SECRET must contain at least 32 characters"]);
  }
  const outreachProvider = env.OUTREACH_MODEL_PROVIDER || CREATOR_OUTREACH_PROFILE.model.provider;
  const outreachModelId = env.OUTREACH_MODEL_ID || CREATOR_OUTREACH_PROFILE.model.modelId;
  const ideaProvider = env.IDEA_MODEL_PROVIDER || IDEA_INVENTOR_PROFILE.model.provider;
  const ideaModelId = env.IDEA_MODEL_ID || IDEA_INVENTOR_PROFILE.model.modelId;
  const interactiveModel = `${env.ASSISTANT_MODEL_PROVIDER}/${env.ASSISTANT_MODEL_ID}`;
  const outreachModel = `${outreachProvider}/${outreachModelId}`;
  const ideaModel = `${ideaProvider}/${ideaModelId}`;
  const modelWhitelist = parseModelWhitelist(env.MODEL_WHITELIST, [
    interactiveModel,
    outreachModel,
    ideaModel,
    "google-vertex/gemini-3.1-flash-lite",
  ]);
  const missingModels = [interactiveModel, outreachModel, ideaModel].filter((model) => !modelWhitelist.includes(model));
  if (missingModels.length > 0) {
    throw new ConfigError(missingModels.map((model) => `MODEL_WHITELIST does not allow configured model ${model}`));
  }

  if (environment === process.env) {
    normalizeGoogleVertexEnv(env.ASSISTANT_MODEL_PROVIDER);
    if (outreachProvider !== env.ASSISTANT_MODEL_PROVIDER) normalizeGoogleVertexEnv(outreachProvider);
    if (ideaProvider !== env.ASSISTANT_MODEL_PROVIDER) normalizeGoogleVertexEnv(ideaProvider);
  }

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    host: env.HOST,
    port: env.PORT,
    corsOrigins,
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
    ideaImage: {
      baseUrl: env.IDEA_IMAGE_BASE_URL || env.AZURE_IMAGE_BASE_URL,
      apiKey: env.IDEA_IMAGE_API_KEY || env.AZURE_IMAGE_API_KEY,
      model: env.IDEA_IMAGE_MODEL || env.AZURE_IMAGE_DEPLOYMENT || "gpt-image-2",
      quality: env.IDEA_IMAGE_QUALITY,
      timeoutMs: env.IDEA_IMAGE_TIMEOUT_MS,
    },
    ideaAssets: {
      storage: env.IDEA_ASSET_STORAGE || (env.NODE_ENV === "test" ? "local" : "s3"),
      bucket: env.USER_PUBLIC_IMAGES_BUCKET || (env.NODE_ENV === "production"
        ? "user-public-images-829115578968"
        : "user-public-images-829115578968-dev"),
      // Reuse Carmack's IAM-authorized public dist key space.
      prefix: "public/game",
      cdnBaseUrl: env.NODE_ENV === "production"
        ? "https://cdn-cf.loopit.me"
        : "https://cdn-cf-dev.loopit.me",
    },
    modelWhitelist,
    agentProfileOverrides: {
      "creator-chat": {
        model: {
          provider: env.ASSISTANT_MODEL_PROVIDER,
          modelId: env.ASSISTANT_MODEL_ID,
          thinkingLevel: env.ASSISTANT_THINKING_LEVEL,
          temperature: env.ASSISTANT_TEMPERATURE,
        },
        runtime: {
          maxTurns: env.ASSISTANT_MAX_TURNS,
          timeoutMs: env.ASSISTANT_TIMEOUT_MS,
        },
      },
      "creator-outreach": {
        model: {
          provider: outreachProvider,
          modelId: outreachModelId,
          thinkingLevel: env.OUTREACH_THINKING_LEVEL,
          temperature: env.OUTREACH_TEMPERATURE,
        },
        runtime: {
          maxTurns: env.OUTREACH_MAX_TURNS,
          timeoutMs: env.OUTREACH_TIMEOUT_MS,
        },
      },
      "idea-inventor": {
        model: { provider: ideaProvider, modelId: ideaModelId, thinkingLevel: env.IDEA_THINKING_LEVEL },
        runtime: { timeoutMs: env.IDEA_TIMEOUT_MS },
      },
      "idea-auditor": {
        model: { provider: ideaProvider, modelId: ideaModelId, thinkingLevel: env.IDEA_THINKING_LEVEL },
        runtime: { timeoutMs: env.IDEA_TIMEOUT_MS },
      },
      "idea-converger": {
        model: { provider: ideaProvider, modelId: ideaModelId, thinkingLevel: env.IDEA_THINKING_LEVEL },
        runtime: { timeoutMs: env.IDEA_TIMEOUT_MS },
      },
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
    remoteSkills: {
      enabled: env.REMOTE_SKILLS_ENABLED,
      bucket: env.SKILL_S3_BUCKET,
      prefix: env.SKILL_S3_PREFIX,
      cacheDir: resolve(env.SKILL_CACHE_DIR),
      timeoutMs: env.SKILL_FETCH_TIMEOUT_MS,
      maxBytes: env.SKILL_MAX_BYTES,
    },
    conversationArchive: {
      enabled: env.CONVERSATION_ARCHIVE_ENABLED,
      bucket: env.CONVERSATION_ARCHIVE_BUCKET,
      prefix: env.CONVERSATION_ARCHIVE_PREFIX,
    },
    opsMcp: {
      url: env.OPS_MCP_URL,
      token: env.OPS_MCP_TOKEN,
      timeoutMs: env.OPS_MCP_TIMEOUT_MS,
      maxResponseBytes: env.OPS_MCP_MAX_RESPONSE_BYTES,
    },
    publicDir: resolve(env.PUBLIC_DIR),
    agentPromptsDir: resolve(env.AGENT_PROMPTS_DIR),
    segmentsFile: resolve(env.SEGMENTS_FILE),
    scheduledTasksFile: resolve(env.SCHEDULED_TASKS_FILE),
  };
}
