import assert from "node:assert/strict";
import test from "node:test";
import { KeyedMutex } from "./keyedMutex.js";

test("KeyedMutex serializes one conversation without blocking another", async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });

  const first = mutex.runExclusive("conversation-a", async () => {
    events.push("a:start");
    await hold;
    events.push("a:end");
  });
  const second = mutex.runExclusive("conversation-a", async () => events.push("a2"));
  const other = mutex.runExclusive("conversation-b", async () => events.push("b"));

  await other;
  assert.deepEqual(events, ["a:start", "b"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a:start", "b", "a:end", "a2"]);
});
