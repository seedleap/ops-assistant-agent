import assert from "node:assert/strict";
import test from "node:test";
import { stripJsonFence } from "./langfuse.js";

test("Langfuse llm-call output removes an enclosing JSON fence", () => {
  assert.equal(
    stripJsonFence("```json\n{\n  \"kernels\": []\n}\n```"),
    "{\n  \"kernels\": []\n}",
  );
});

test("Langfuse llm-call output preserves ordinary text and extracts JSON after a preface", () => {
  assert.equal(stripJsonFence("plain response"), "plain response");
  assert.equal(stripJsonFence("说明文字\n```json\n{}\n```"), "{}");
});
