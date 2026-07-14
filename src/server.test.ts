import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import pino from "pino";
import request from "supertest";
import { OpsAssistant } from "./agent/assistant.js";
import { loadConfig } from "./config.js";
import { OutreachScheduler } from "./scheduler.js";
import { createApp } from "./server.js";
import { JsonStore } from "./store.js";

const jwtSecret = "test-secret-that-is-at-least-32-characters";
const logger = pino({ enabled: false });

test("health is public while API routes require a valid JWT", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ops-http-"));
  try {
    const config = loadConfig({
      NODE_ENV: "test",
      ASSISTANT_DRY_RUN: "true",
      API_AUTH_MODE: "jwt",
      API_JWT_SECRET: jwtSecret,
      CORS_ORIGINS: "https://ops.loopit.example",
      STATIC_UI_ENABLED: "false",
      DATA_DIR: dataDir,
    });
    const store = await JsonStore.open(config.dataDir);
    const assistant = new OpsAssistant(config);
    const scheduler = new OutreachScheduler(config, store, assistant, logger);
    const app = createApp({ config, store, assistant, scheduler, logger });

    await request(app).get("/health").expect(200, { ok: true });
    await request(app).get("/").expect(401, { error: "unauthorized" });
    await request(app).get("/state").expect(401, { error: "unauthorized" });

    const preflight = await request(app)
      .options("/state")
      .set("Origin", "https://ops.loopit.example")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "Authorization,Content-Type")
      .expect(204);
    assert.equal(preflight.headers["access-control-allow-origin"], "https://ops.loopit.example");
    assert.match(preflight.headers["access-control-allow-headers"], /Authorization/);

    const token = await new SignJWT({ scope: "ops-agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));
    const response = await request(app)
      .get("/state")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    assert.deepEqual(response.body.conversations, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
