import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig } from "./config.js";

test("loadConfig parses explicit runtime values", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    API_AUTH_MODE: "none",
    HOST: "127.0.0.1",
    PORT: "9010",
    CORS_ORIGINS: "https://ops.loopit.example,https://admin.loopit.example",
    TRUST_PROXY_HOPS: "1",
    STATIC_UI_ENABLED: "false",
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
  assert.equal(config.schedulerEnabled, false);
  assert.equal(config.assistantDryRun, true);
  assert.equal(config.interactiveAgent.temperature, 0.4);
});

test("loadConfig requires JWT authentication configuration in production", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    (error) => error instanceof ConfigError && error.message.includes("API_JWT_SECRET"),
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

test("loadConfig rejects profiles outside the model whitelist", () => {
  assert.throws(
    () => loadConfig({ MODEL_WHITELIST: "google-vertex/gemini-3.1-flash-lite" }),
    (error) => error instanceof ConfigError && error.message.includes("does not allow configured model"),
  );
});
