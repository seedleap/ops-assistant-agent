import assert from "node:assert/strict";
import test from "node:test";
import { usageDelta } from "./events.js";

test("usageDelta reports Gemini prompt cache hit rate", () => {
  const before = {
    tokens: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, total: 160 },
    cost: 1,
  } as never;
  const after = {
    tokens: { input: 130, output: 25, cacheRead: 170, cacheWrite: 20, total: 345 },
    cost: 2,
  } as never;

  const usage = usageDelta(before, after, "gemini");
  assert.equal(usage.inputTokens, 30);
  assert.equal(usage.cacheReadTokens, 120);
  assert.equal(usage.cacheWriteTokens, 20);
  assert.equal(usage.cacheHitRate, 120 / 170);
});
