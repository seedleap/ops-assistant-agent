import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "./store.js";

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
