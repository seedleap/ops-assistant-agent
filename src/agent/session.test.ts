import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { selectSessionTools } from "./session.js";

const customTool: ToolDefinition = {
  name: "query_public_work",
  label: "test",
  description: "test tool",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
};

test("session tool selection preserves Pi built-ins without treating them as custom tools", () => {
  const selected = selectSessionTools(["read", "query_public_work"], [customTool]);
  assert.deepEqual(selected.toolNames, ["read", "query_public_work"]);
  assert.deepEqual(selected.customTools, [customTool]);
});

test("session tool selection rejects unknown and duplicate profile entries", () => {
  assert.throws(
    () => selectSessionTools(["read", "missing"], [customTool]),
    /unknown tool: missing/,
  );
  assert.throws(
    () => selectSessionTools(["read", "read"], [customTool]),
    /duplicate tool names/,
  );
});
