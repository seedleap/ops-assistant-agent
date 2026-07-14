import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OPS_MCP_TOOL_NAMES, RemoteOpsMcpClient } from "./opsMcpClient.js";

test("remote MCP client authenticates, discovers the allowlist and calls a tool", async () => {
  const app = express();
  app.use(express.json());
  const authorizationHeaders: Array<string | undefined> = [];

  app.post("/mcp", async (req, res) => {
    authorizationHeaders.push(req.header("authorization"));
    const mcp = new McpServer({ name: "ops-data-test", version: "1.0.0" });
    for (const name of OPS_MCP_TOOL_NAMES) {
      mcp.registerTool(name, {
        description: `Test ${name}`,
        inputSchema: z.object({}).passthrough(),
        annotations: { readOnlyHint: true, idempotentHint: true },
      }, async (args) => ({
        content: [{ type: "text", text: JSON.stringify({ ok: true, name, args }) }],
      }));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.once("close", () => void Promise.allSettled([transport.close(), mcp.close()]));
  });
  app.get("/mcp", (_req, res) => res.sendStatus(405));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const client = new RemoteOpsMcpClient({
    url: `http://127.0.0.1:${port}/mcp`,
    token: "test-service-token",
    timeoutMs: 5_000,
    maxResponseBytes: 64 * 1024,
  });

  try {
    const result = await client.callTool("query_work_overview", { pid: "p_1", days: 7 });
    const text = result.content?.find((item) => item.type === "text")?.text;
    assert.match(String(text), /query_work_overview/);
    assert.match(String(text), /p_1/);
    assert.ok(authorizationHeaders.length >= 3);
    assert.ok(authorizationHeaders.every((value) => value === "Bearer test-service-token"));
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
