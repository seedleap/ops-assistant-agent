import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { PiAssistant } from "./piAssistant.js";
import { OutreachScheduler } from "./scheduler.js";
import { JsonStore } from "./store.js";

function testConfig(dataDir: string): AppConfig {
  return {
    port: 0,
    dataDir,
    schedulerPollMs: 60_000,
    defaultOutreachSilentMinutes: 60,
    interactiveSessionTimeoutMinutes: 60,
    assistantDryRun: true,
    opsDataFile: join(process.cwd(), "sample-data", "metrics.json"),
    loopitDataFile: join(process.cwd(), "sample-data", "loopit-data.json"),
    skillsDir: join(process.cwd(), "skills"),
    pythonBin: "python3",
    opsQueryScript: join(process.cwd(), "scripts", "ops_query.py"),
    publicDir: join(process.cwd(), "public"),
    systemPromptFile: join(process.cwd(), "config", "system-prompt.md"),
    segmentsFile: join(process.cwd(), "config", "user-segments.json"),
    scheduledTasksFile: join(process.cwd(), "config", "scheduled-tasks.json"),
  };
}

test("scheduler defers outreach until the configured silent window passes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-assistant-"));
  try {
    const config = testConfig(dir);
    const store = await JsonStore.open(dir);
    const assistant = new PiAssistant(config);
    const scheduler = new OutreachScheduler(config, store, assistant);

    const base = new Date("2026-06-23T10:00:00.000Z");
    await store.recordUserMessage({ userId: "u1", text: "hello", createdAt: base });
    const schedule = await store.createSchedule({
      userId: "u1",
      name: "check",
      prompt: "check metrics",
      intervalMinutes: 60,
      silentMinutes: 60,
      nextRunAt: base,
    });

    const first = await scheduler.tick(new Date("2026-06-23T10:30:00.000Z"));
    assert.equal(first[0]?.scheduleId, schedule.id);
    assert.equal(first[0]?.action, "deferred_until_silent");
    assert.equal(store.listOutbox().length, 0);

    const second = await scheduler.tick(new Date("2026-06-23T11:01:00.000Z"));
    assert.equal(second[0]?.action, "created_outbox");
    assert.equal(store.listOutbox("pending").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schedule uses the default silent window when silentMinutes is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-assistant-"));
  try {
    const config = testConfig(dir);
    const store = await JsonStore.open(dir);
    const schedule = await store.createSchedule({
      userId: "u1",
      name: "default silent",
      prompt: "check metrics",
      intervalMinutes: 60,
      silentMinutes: config.defaultOutreachSilentMinutes,
    });
    assert.equal(schedule.silentMinutes, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
