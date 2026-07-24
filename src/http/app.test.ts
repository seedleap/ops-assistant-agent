import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import pino from "pino";
import request from "supertest";
import { OpsAssistant } from "../agent/assistant.js";
import { loadConfig } from "../config.js";
import { OutreachScheduler } from "../infrastructure/scheduler/outreach-scheduler.js";
import { createApp } from "./app.js";
import { JsonStore } from "../infrastructure/persistence/json-store.js";

const jwtSecret = "test-secret-that-is-at-least-32-characters";
const logger = pino({ enabled: false });

test("health is public while API routes require a valid JWT", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ops-http-"));
  try {
    const promptsDir = join(dataDir, "agent-profiles");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "creator-chat.md"), "chat prompt");
    await writeFile(join(promptsDir, "creator-outreach.md"), "outreach prompt");
    const config = loadConfig({
      NODE_ENV: "test",
      ASSISTANT_DRY_RUN: "true",
      API_AUTH_MODE: "jwt",
      API_JWT_SECRET: jwtSecret,
      CORS_ORIGINS: "https://ops.loopit.example",
      STATIC_UI_ENABLED: "false",
      DATA_DIR: dataDir,
      AGENT_PROMPTS_DIR: promptsDir,
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

    const profiles = await request(app)
      .get("/config/agent-profiles")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    assert.deepEqual(profiles.body.profiles.map((profile: { id: string }) => profile.id), [
      "creator-chat",
      "creator-outreach",
    ]);
    assert.equal(profiles.body.profiles[0].promptVersion, "creator-support-v7-time-context");
    assert.equal(profiles.body.profiles[1].promptVersion, "creator-outreach-v6-contract");
    assert.deepEqual(profiles.body.profiles[0].localSkills, [
      "analyze-project",
      "summarize-comments",
      "analyze-account",
      "search-docs",
    ]);
    assert.deepEqual(profiles.body.profiles[0].toolNames, [
      "read",
      "query_public_work",
      "analyze_work_comments",
      "query_creator_account_summary",
    ]);

    await request(app)
      .get("/config/agent-profiles/creator-outreach/system-prompt")
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { profileId: "creator-outreach", content: "outreach prompt" });
    await request(app)
      .put("/config/agent-profiles/creator-outreach/system-prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "updated outreach prompt" })
      .expect(200, { ok: true, profileId: "creator-outreach" });
    await request(app)
      .put("/config/agent-profiles/creator-outreach/system-prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "   " })
      .expect(400);
    await request(app)
      .get("/config/system-prompt")
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { profileId: "creator-chat", content: "chat prompt" });
    await request(app)
      .get("/config/agent-profiles/unknown/system-prompt")
      .set("Authorization", `Bearer ${token}`)
      .expect(404, { error: "unknown agent profile" });

    await request(app)
      .post("/im/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "u".repeat(129), text: "hello" })
      .expect(400);
    await request(app)
      .post("/im/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "u1", text: "hello", timezone: "Mars/Olympus" })
      .expect(400);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed non-stream runs are persisted as failed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ops-http-failure-"));
  try {
    const config = loadConfig({ NODE_ENV: "test", ASSISTANT_DRY_RUN: "true", DATA_DIR: dataDir });
    const store = await JsonStore.open(config.dataDir);
    const assistant = {
      run: async () => { throw new Error("forced failure"); },
      close: async () => {},
    } as unknown as OpsAssistant;
    const scheduler = {
      tick: async () => [],
      start: () => {},
      stop: () => {},
    } as unknown as OutreachScheduler;
    const app = createApp({ config, store, assistant, scheduler, logger });

    await request(app)
      .post("/im/messages")
      .send({ userId: "u1", text: "hello", reply: true })
      .expect(500);

    assert.deepEqual(store.snapshot().runs.map((run) => run.status), ["failed"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
