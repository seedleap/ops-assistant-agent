import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IdeaWorkflowRecord } from "../../domain/types.js";
import { JsonStore } from "./json-store.js";

function queuedIdeaRecord(id: string, idempotencyKey: string): IdeaWorkflowRecord {
  const now = new Date().toISOString();
  return {
    id,
    idempotencyKey,
    inputHash: id,
    userId: "u1",
    status: "queued",
    stage: "queued",
    input: {},
    ideas: [],
    checkpoints: {},
    attempt: 0,
    metadata: { workflowVersion: "test", promptVersion: "test", modelIds: [] },
    createdAt: now,
    updatedAt: now,
  };
}

test("JsonStore serializes concurrent writes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ops-store-"));
  try {
    const store = await JsonStore.open(dataDir);
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.recordUserMessage({
      userId: `user-${index}`,
      text: `message-${index}`,
    })));

    const reopened = await JsonStore.open(dataDir);
    assert.equal(reopened.snapshot().messages.length, 20);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Idea workflow admission is atomic per user", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ops-idea-admission-"));
  try {
    const store = await JsonStore.open(dataDir);
    const results = await Promise.all([
      store.createIdeaWorkflowIfAbsent(queuedIdeaRecord("idea-1", "submit-001")),
      store.createIdeaWorkflowIfAbsent(queuedIdeaRecord("idea-2", "submit-002")),
      store.createIdeaWorkflowIfAbsent(queuedIdeaRecord("idea-3", "submit-003")),
    ]);
    assert.equal(results.filter((result) => result.created).length, 2);
    assert.equal(results.filter((result) => result.capacityExceeded).length, 1);
    assert.equal(store.snapshot().ideaWorkflows.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("conversation recovery keeps messages after the Pi session directory is lost", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ops-recovery-"));
  try {
    const store = await JsonStore.open(dataDir);
    await store.recordUserMessage({ userId: "u1", imThreadId: "thread-1", text: "帮我设计一个创作者活动" });
    const session = await store.createSession({
      id: "sess_old",
      userId: "u1",
      imThreadId: "thread-1",
      type: "interactive",
      sessionDir: join(dataDir, "missing-session"),
    });
    await store.recordAssistantMessage({ userId: "u1", imThreadId: "thread-1", text: "可以先按目标人群和任务拆分", sourceRunId: "run-1" });
    await store.updateConversationSummary("u1", "thread-1", session.id);

    const recovery = store.buildRecoveryContext("u1", "thread-1", session.id);
    assert.match(recovery, /创作者活动/);
    assert.match(recovery, /目标人群/);

    const reopened = await JsonStore.open(dataDir);
    assert.equal(reopened.snapshot().sessions[0]?.id, "sess_old");
    assert.match(reopened.getConversation("u1", "thread-1")?.summary ?? "", /创作者活动/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
