import assert from "node:assert/strict";
import test from "node:test";
import { createCreatorWorksTool, createWorkOverviewTool } from "./data-tools.js";
import type { OpsMcpToolCaller, OpsMcpToolName } from "./mcp-client.js";

interface TestToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

async function execute(tool: ReturnType<typeof createCreatorWorksTool>, params: Record<string, unknown>): Promise<TestToolResult> {
  return await tool.execute("test-call", params, undefined, undefined, undefined as never) as unknown as TestToolResult;
}

test("ops tools preserve the stable Pi contract while calling MCP", async () => {
  const calls: Array<{ name: OpsMcpToolName; args: Record<string, unknown> }> = [];
  const client: OpsMcpToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
  };

  const result = await execute(createCreatorWorksTool(client), {
    uid: "u_1",
    limit: 20,
    publicOnly: true,
  });

  assert.deepEqual(calls, [{
    name: "query_creator_works",
    args: { uid: "u_1", limit: 20, publicOnly: true },
  }]);
  assert.equal(result.isError, false);
  assert.equal(result.details.transport, "mcp");
});

test("ops tools keep transport diagnostics out of model-facing errors", async () => {
  const client: OpsMcpToolCaller = {
    async callTool() {
      throw new Error("Authorization: Bearer private-token");
    },
  };

  const result = await execute(createWorkOverviewTool(client), { pid: "p_1" });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /运营数据服务暂时不可用/);
  assert.doesNotMatch(result.content[0].text, /private-token/);
  assert.match(String(result.details.error), /private-token/);
});
