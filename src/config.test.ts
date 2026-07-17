import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig } from "./config.js";

test("loadConfig parses explicit runtime values", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    API_AUTH_MODE: "jwt",
    API_JWT_SECRET: "test-secret-that-is-at-least-32-characters",
    HOST: "127.0.0.1",
    PORT: "9010",
    CORS_ORIGINS: "https://ops.loopit.example,https://admin.loopit.example",
    TRUST_PROXY_HOPS: "1",
    STATIC_UI_ENABLED: "false",
    OPS_MCP_URL: "https://ops-data.example.com/mcp",
    OPS_MCP_TOKEN: "service-token",
    OPS_MCP_TIMEOUT_MS: "45000",
    OPS_MCP_MAX_RESPONSE_BYTES: "1048576",
    SCHEDULER_ENABLED: "false",
    ASSISTANT_DRY_RUN: "true",
    ASSISTANT_MODEL_PROVIDER: "google-vertex",
    ASSISTANT_MODEL_ID: "gemini-3-flash-preview",
    ASSISTANT_TEMPERATURE: "0.4",
  });

  assert.equal(config.nodeEnv, "production");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 9_010);
  assert.deepEqual(config.corsOrigins, ["https://ops.loopit.example", "https://admin.loopit.example"]);
  assert.equal(config.trustProxyHops, 1);
  assert.equal(config.staticUiEnabled, false);
  assert.deepEqual(config.opsMcp, {
    url: "https://ops-data.example.com/mcp",
    token: "service-token",
    timeoutMs: 45_000,
    maxResponseBytes: 1_048_576,
  });
  assert.equal(config.schedulerEnabled, false);
  assert.equal(config.assistantDryRun, true);
  assert.equal(config.agentProfileOverrides["creator-chat"]?.model?.temperature, 0.4);
  assert.equal(config.agentProfileOverrides["creator-chat"]?.runtime?.maxTurns, 10);
  assert.equal(config.agentProfileOverrides["creator-outreach"]?.runtime?.maxTurns, 6);
  assert.equal(config.agentProfileOverrides["idea-inventor"]?.model?.provider, "azure-openai-responses");
  assert.equal(config.agentProfileOverrides["idea-inventor"]?.model?.modelId, "gpt-5.5");
  assert.ok(config.modelWhitelist.includes("azure-openai-responses/gpt-5.5"));
  assert.match(config.agentPromptsDir, /config\/agent-profiles$/);
});

test("loadConfig requires JWT authentication configuration in production", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      API_AUTH_MODE: "jwt",
      CORS_ORIGINS: "https://ops.loopit.example",
      STATIC_UI_ENABLED: "false",
      ASSISTANT_DRY_RUN: "true",
    }),
    (error) => error instanceof ConfigError && error.message.includes("API_JWT_SECRET"),
  );
});

test("loadConfig rejects insecure production overrides", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      API_AUTH_MODE: "none",
      CORS_ORIGINS: "https://ops.loopit.example",
      STATIC_UI_ENABLED: "false",
      ASSISTANT_DRY_RUN: "true",
    }),
    (error) => error instanceof ConfigError && error.message.includes("API_AUTH_MODE=jwt"),
  );
});

test("loadConfig requires the remote MCP service for a live production agent", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      API_JWT_SECRET: "test-secret-that-is-at-least-32-characters",
      CORS_ORIGINS: "https://ops.loopit.example",
      STATIC_UI_ENABLED: "false",
      ASSISTANT_DRY_RUN: "false",
    }),
    (error) => error instanceof ConfigError && error.message.includes("OPS_MCP_URL"),
  );
});

test("loadConfig rejects invalid values instead of silently using defaults", () => {
  assert.throws(
    () => loadConfig({ PORT: "not-a-port" }),
    (error) => error instanceof ConfigError && error.message.includes("PORT"),
  );
});

test("loadConfig requires Langfuse credentials when tracing is enabled", () => {
  assert.throws(
    () => loadConfig({ LANGFUSE_ENABLED: "true" }),
    (error) => error instanceof ConfigError && error.message.includes("LANGFUSE_PUBLIC_KEY"),
  );
});

test("loadConfig isolates Idea images in the workspace lab namespace", () => {
  const development = loadConfig();
  assert.equal(development.assistantDryRun, false);
  assert.equal(development.ideaAssets.storage, "s3");
  assert.equal(development.ideaAssets.bucket, "leap-workspace-shared-dev");
  assert.equal(development.ideaAssets.cdnBaseUrl, "https://cdn-cf-dev.loopit.me");
  assert.equal(development.ideaAssets.prefix, "lab/ideas");

  const testConfig = loadConfig({ NODE_ENV: "test" });
  assert.equal(testConfig.ideaImage.model, "gpt-image-2");
  assert.equal(testConfig.ideaImage.quality, "low");
  assert.equal(testConfig.ideaImage.size, "1024x1536");
  assert.equal(testConfig.ideaImage.background, "opaque");
  assert.equal(testConfig.ideaImage.outputFormat, "png");
  assert.equal(testConfig.ideaAssets.storage, "local");

  const production = loadConfig({
    NODE_ENV: "production",
    ASSISTANT_DRY_RUN: "true",
    STATIC_UI_ENABLED: "false",
    CORS_ORIGINS: "https://ops.loopit.me",
    API_AUTH_MODE: "jwt",
    API_JWT_SECRET: "a".repeat(32),
  });
  assert.equal(production.ideaAssets.bucket, "leap-workspace-shared-dev");
  assert.equal(production.ideaAssets.prefix, "lab/ideas");
  assert.equal(production.ideaAssets.cdnBaseUrl, "https://cdn-cf-dev.loopit.me");

  const overridden = loadConfig({
    NODE_ENV: "production",
    ASSISTANT_DRY_RUN: "true",
    STATIC_UI_ENABLED: "false",
    CORS_ORIGINS: "https://ops.loopit.me",
    API_AUTH_MODE: "jwt",
    API_JWT_SECRET: "a".repeat(32),
    IDEA_ASSET_BUCKET: "custom-workspace-bucket",
    IDEA_ASSET_PREFIX: "custom/ideas",
    IDEA_ASSET_CDN_BASE_URL: "https://assets.example.com",
  });
  assert.equal(overridden.ideaAssets.bucket, "custom-workspace-bucket");
  assert.equal(overridden.ideaAssets.prefix, "custom/ideas");
  assert.equal(overridden.ideaAssets.cdnBaseUrl, "https://assets.example.com");
});

test("loadConfig reuses the shared Azure image credential for Idea text agents", () => {
  const config = loadConfig({
    ASSISTANT_DRY_RUN: "true",
    IDEA_IMAGE_API_KEY: "shared-azure-key",
    IDEA_IMAGE_BASE_URL: "https://shared-resource.cognitiveservices.azure.com",
  });

  assert.deepEqual(config.azureOpenAi, {
    apiKey: "shared-azure-key",
    baseUrl: "https://shared-resource.cognitiveservices.azure.com",
    apiVersion: "v1",
  });
});

test("loadConfig rejects profiles outside the model whitelist", () => {
  assert.throws(
    () => loadConfig({ MODEL_WHITELIST: "google-vertex/gemini-3.1-flash-lite" }),
    (error) => error instanceof ConfigError && error.message.includes("does not allow configured model"),
  );
});
