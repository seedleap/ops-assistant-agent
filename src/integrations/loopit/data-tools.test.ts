import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createCreatorActivityStatusTool,
  createCreatorSupportTools,
  createCreatorWorkResolverTool,
  createCreatorWorksTool,
  createDataPrimitiveTools,
  createOpsDataTools,
  createWorkAnalysisTool,
  createWorkOverviewTool,
} from "./data-tools.js";
import type { OpsMcpToolCaller, OpsMcpToolName } from "./mcp-client.js";
import {
  CREATOR_SUPPORT_TOOL_BINDINGS,
  CREATOR_SUPPORT_TOOL_NAMES,
  DATA_PRIMITIVE_TOOL_NAMES,
} from "./tool-catalog.js";

interface TestToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

async function execute(tool: ToolDefinition, params: Record<string, unknown>): Promise<TestToolResult> {
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

test("creator-support tools preserve ownership and authority arguments", async () => {
  const calls: Array<{ name: OpsMcpToolName; args: Record<string, unknown> }> = [];
  const client: OpsMcpToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      return { structuredContent: { ok: true, as_of: "2026-07-22T00:00:00+08:00" } };
    },
  };

  await execute(createWorkAnalysisTool(client), {
    uid: "u_1",
    pid: "p_1",
    windowDays: 14,
  });
  await execute(createCreatorActivityStatusTool(client), {
    uid: "u_1",
    campaignId: "campaign_1",
    includeProgress: true,
  });

  assert.deepEqual(calls, [
    { name: "query_work_analysis", args: { uid: "u_1", pid: "p_1", windowDays: 14 } },
    {
      name: "query_creator_activity_status",
      args: { uid: "u_1", campaignId: "campaign_1", includeProgress: true },
    },
  ]);
  const names = createOpsDataTools(client).map((tool) => tool.name);
  assert.equal(names.length, new Set(names).size);
  assert.equal(names.length, 14);
});

test("the Agent sees eight business tools while MCP primitives remain behind the boundary", async () => {
  const client: OpsMcpToolCaller = {
    async callTool() {
      return { structuredContent: { ok: true } };
    },
  };

  const agentTools = createCreatorSupportTools(client);
  const primitiveTools = createDataPrimitiveTools(client);
  assert.deepEqual(agentTools.map((tool) => tool.name), CREATOR_SUPPORT_TOOL_NAMES);
  for (const tool of agentTools) {
    assert.ok(tool.description.length >= 80, `${tool.name} needs a decision-oriented description`);
    const schema = tool.parameters as unknown as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false, `${tool.name} must reject unknown arguments`);
    assert.ok(schema.properties?.responseFormat, `${tool.name} must support concise/detailed responses`);
  }
  assert.deepEqual(primitiveTools.map((tool) => tool.name), [
    "query_work_overview",
    "query_creator_works",
    "query_work_profile",
    "query_work_consumption",
    "query_work_comments",
    "query_work_prompt",
  ]);
  assert.deepEqual(new Set(DATA_PRIMITIVE_TOOL_NAMES), new Set(primitiveTools.map((tool) => tool.name)));
  assert.equal(new Set([
    ...agentTools.map((tool) => tool.name),
    ...primitiveTools.map((tool) => tool.name),
  ]).size, 14);

  const calls: Array<{ name: OpsMcpToolName; args: Record<string, unknown> }> = [];
  const routingClient: OpsMcpToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      return { structuredContent: { ok: true } };
    },
  };
  await execute(createCreatorWorkResolverTool(routingClient), {
    uid: "u_1",
    limit: 5,
    publicOnly: true,
    responseFormat: "concise",
  });
  assert.deepEqual(calls, [{
    name: CREATOR_SUPPORT_TOOL_BINDINGS.creator_work_resolve,
    args: { uid: "u_1", limit: 5, publicOnly: true, responseFormat: "concise" },
  }]);
});
