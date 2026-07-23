import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createCommentAnalysisTool,
  createCreatorAccountSummaryTool,
  createCreatorActivityStatusTool,
  createCreatorSupportTools,
  createCreatorWorksTool,
  createDataPrimitiveTools,
  createOpsDataTools,
  createProjectAnalysisTool,
  createWorkOverviewTool,
  resolvePublicProjectPid,
} from "./data-tools.js";
import { OPS_MCP_TOOL_NAMES, type OpsMcpToolCaller, type OpsMcpToolName } from "./mcp-client.js";
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

test("revision 4291 business tools enforce public-project and fixed-window contracts", async () => {
  const calls: Array<{ name: OpsMcpToolName; args: Record<string, unknown> }> = [];
  const client: OpsMcpToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      return { structuredContent: { ok: true, as_of: "2026-07-23T00:00:00+08:00" } };
    },
  };

  await execute(createProjectAnalysisTool(client), {
    pid: "https://loopit.example/project/p_public?from=share",
    responseFormat: "concise",
  });
  await execute(createCommentAnalysisTool(client), { pid: "p_public", responseFormat: "detailed" });
  const context = { creatorUid: "u_bound" };
  await execute(createCreatorAccountSummaryTool(client, context), {
    uid: "u_attacker",
    responseFormat: "concise",
  });
  await execute(createCreatorActivityStatusTool(client, context), {
    uid: "u_attacker",
    campaignId: "campaign_1",
    includeProgress: true,
  });

  assert.deepEqual(calls, [
    {
      name: "query_public_work",
      args: { pid: "p_public", responseFormat: "concise" },
    },
    {
      name: "analyze_work_comments",
      args: { pid: "p_public", responseFormat: "detailed", sort: "top_likes", limit: 50 },
    },
    {
      name: "query_creator_account_summary",
      args: { uid: "u_bound", responseFormat: "concise", days: 7, topWorksLimit: 3, publishedWithinDays: 180 },
    },
    {
      name: "query_creator_activity_status",
      args: { uid: "u_bound", campaignId: "campaign_1", includeProgress: true },
    },
  ]);
});

test("the Agent-facing catalog stays smaller than the MCP primitive layer", async () => {
  const client: OpsMcpToolCaller = {
    async callTool() {
      return { structuredContent: { ok: true } };
    },
  };

  const context = { creatorUid: "u_bound" };
  const agentTools = createCreatorSupportTools(client, context);
  const primitiveTools = createDataPrimitiveTools(client);
  assert.deepEqual(agentTools.map((tool) => tool.name), CREATOR_SUPPORT_TOOL_NAMES);
  assert.deepEqual(agentTools.map((tool) => tool.name), [
    "creator_project_analyze",
    "creator_comments_analyze",
    "creator_account_summarize",
    "creator_activity_status",
  ]);
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
  assert.equal(new Set(createOpsDataTools(client, context).map((tool) => tool.name)).size, 10);
  assert.deepEqual(CREATOR_SUPPORT_TOOL_BINDINGS, {
    creator_project_analyze: "query_public_work",
    creator_comments_analyze: "analyze_work_comments",
    creator_account_summarize: "query_creator_account_summary",
    creator_activity_status: "query_creator_activity_status",
  });
  assert.equal(OPS_MCP_TOOL_NAMES.includes("query_creator_inspiration_context" as never), false);
  assert.equal(OPS_MCP_TOOL_NAMES.includes("search_creation_catalog" as never), false);
});

test("public project references are normalized before MCP calls", async () => {
  assert.equal(resolvePublicProjectPid("p_1001"), "p_1001");
  assert.equal(resolvePublicProjectPid("https://loopit.example/project/p_2001?from=share"), "p_2001");
  assert.equal(resolvePublicProjectPid("https://loopit.example/play?pid=p_3001"), "p_3001");
  assert.throws(() => resolvePublicProjectPid("https://loopit.example/project/"), /无法从链接中识别/);
  assert.throws(() => resolvePublicProjectPid("not a pid or url"), /有效的公开作品/);
});

test("business tools reject successful responses without as_of", async () => {
  const client: OpsMcpToolCaller = {
    async callTool() {
      return { structuredContent: { ok: true } };
    },
  };
  const result = await execute(createProjectAnalysisTool(client), { pid: "p_1" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /缺少必要的 ok 或 as_of/);
});
