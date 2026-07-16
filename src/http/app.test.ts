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
import { AzureIdeaImageGenerator } from "../integrations/images/idea-image.js";
import { IdeaWorkflow } from "../ideas/workflow.js";
import { LocalIdeaAssetStore } from "../integrations/images/idea-asset-store.js";

const jwtSecret = "test-secret-that-is-at-least-32-characters";
const logger = pino({ enabled: false });

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for test state");
}

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
    const ideaWorkflow = new IdeaWorkflow(
      config,
      store,
      assistant,
      new AzureIdeaImageGenerator(config),
      new LocalIdeaAssetStore(config),
    );
    const app = createApp({ config, store, assistant, scheduler, logger, ideaWorkflow });

    await request(app).get("/health").expect(200, { ok: true });
    await request(app).get("/").expect(401, { error: "unauthorized" });
    await request(app).get("/state").expect(401, { error: "unauthorized" });

    const preflight = await request(app)
      .options("/state")
      .set("Origin", "https://ops.loopit.example")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "Authorization,Content-Type,Idempotency-Key")
      .expect(204);
    assert.equal(preflight.headers["access-control-allow-origin"], "https://ops.loopit.example");
    assert.match(preflight.headers["access-control-allow-headers"], /Authorization/);
    assert.match(preflight.headers["access-control-allow-headers"], /Idempotency-Key/);

    const token = await new SignJWT({ scope: "ops-agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setSubject("idea-user")
      .sign(new TextEncoder().encode(jwtSecret));
    const response = await request(app)
      .get("/state")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    assert.deepEqual(response.body.conversations, []);
    assert.equal(response.body.ideaWorkflows, undefined);

    const profiles = await request(app)
      .get("/config/agent-profiles")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    assert.deepEqual(profiles.body.profiles.map((profile: { id: string }) => profile.id), [
      "creator-chat",
      "creator-outreach",
      "idea-inventor",
      "idea-auditor",
      "idea-converger",
    ]);
    assert.equal(profiles.body.profiles[0].promptVersion, "creator-growth-v2");
    assert.equal(profiles.body.profiles[1].promptVersion, "creator-outreach-v2");
    assert.deepEqual(profiles.body.profiles[0].localSkills, ["creator-guide", "ops-activities"]);
    assert.deepEqual(profiles.body.profiles[0].toolNames, [
      "read",
      "query_work_overview",
      "query_creator_works",
      "query_work_profile",
      "query_work_consumption",
      "query_work_comments",
      "query_work_prompt",
    ]);
    assert.deepEqual(profiles.body.profiles.slice(2).map((profile: { toolNames: string[] }) => profile.toolNames), [[], [], []]);

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

    const generated = await request(app)
      .post("/ideas/generate")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "idea-submit-001")
      .send({
        userId: "idea-user",
        projectId: "project-1",
        theme: "会移动的花园",
        audience: "休闲游戏用户",
        emotion: "轻松但需要快速判断",
        duration: "30 秒",
        count: 2,
      })
      .expect(202);
    assert.equal(generated.body.workflow.status, "queued");
    const completed = await waitFor(() => {
      const value = store.getIdeaWorkflow(generated.body.workflow.id);
      return value?.status === "completed" ? value : undefined;
    });
    assert.equal(completed.ideas.length, 2);
    assert.equal(completed.input.platform, "Loopit 竖屏 Feed");
    assert.equal(completed.ideas[0].image.status, "completed");
    assert.match(completed.ideas[0].image.url || "", /^\/ideas\/assets\/.+\.png$/);

    const replay = await request(app)
      .post("/ideas/generate")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "idea-submit-001")
      .send({
        userId: "idea-user", projectId: "project-1", theme: "会移动的花园",
        audience: "休闲游戏用户", emotion: "轻松但需要快速判断", duration: "30 秒", count: 2,
      })
      .expect(200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.workflow.id, generated.body.workflow.id);
    assert.equal(store.snapshot().ideaWorkflows.length, 1);

    await request(app)
      .post("/ideas/generate")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "idea-submit-001")
      .send({
        userId: "idea-user", theme: "不同主题", audience: "休闲游戏用户",
        emotion: "快速判断", duration: "30 秒", count: 2,
      })
      .expect(409);

    await request(app)
      .post("/ideas/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({
        userId: "idea-user", theme: "无幂等键", audience: "休闲游戏用户", emotion: "快速判断",
      })
      .expect(400);

    await request(app)
      .get(`/ideas/${generated.body.workflow.id}?userId=idea-user`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    await request(app)
      .post("/ideas/generate")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "idea-submit-002")
      .send({
        userId: "idea-user",
        theme: "会移动的花园",
        audience: "休闲游戏用户",
        emotion: "快速判断",
        platform: "自定义平台",
      })
      .expect(400);
    await request(app)
      .get(completed.ideas[0].image.url!)
      .set("Authorization", `Bearer ${token}`)
      .expect("Content-Type", /image\/png/)
      .expect(200);
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
