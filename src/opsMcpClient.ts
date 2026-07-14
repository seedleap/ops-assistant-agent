import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const OPS_MCP_TOOL_NAMES = [
  "query_work_overview",
  "query_creator_works",
  "query_work_profile",
  "query_work_consumption",
  "query_work_comments",
  "query_work_prompt",
] as const;

export type OpsMcpToolName = typeof OPS_MCP_TOOL_NAMES[number];

export interface OpsMcpCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface OpsMcpToolCaller {
  callTool(name: OpsMcpToolName, args: Record<string, unknown>): Promise<OpsMcpCallResult>;
}

export interface OpsMcpClientConfig {
  url?: string;
  token?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

/**
 * Process-wide remote MCP connection for the read-only Loopit data service.
 * The connection is lazy so dry-run/local HTTP checks do not require the data service.
 */
export class RemoteOpsMcpClient implements OpsMcpToolCaller {
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(private readonly config: OpsMcpClientConfig) {}

  async callTool(name: OpsMcpToolName, args: Record<string, unknown>): Promise<OpsMcpCallResult> {
    const client = await this.connect();
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.config.timeoutMs, maxTotalTimeout: this.config.timeoutMs },
    ) as OpsMcpCallResult;
    const responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (responseBytes > this.config.maxResponseBytes) {
      throw new Error(`MCP tool response exceeded ${this.config.maxResponseBytes} bytes`);
    }
    return result;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    await client?.close();
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ||= this.open();
    return this.connecting;
  }

  private async open(): Promise<Client> {
    if (!this.config.url) {
      this.connecting = undefined;
      throw new Error("OPS_MCP_URL is not configured");
    }

    const client = new Client(
      { name: "ops-assistant-agent", version: "0.1.0" },
      { enforceStrictCapabilities: true },
    );
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.connecting = undefined;
      }
    };
    const headers = this.config.token
      ? { Authorization: `Bearer ${this.config.token}` }
      : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: headers ? { headers } : undefined,
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 5_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 2,
      },
    });

    try {
      await client.connect(transport, { timeout: this.config.timeoutMs });
      const listed = await client.listTools(undefined, { timeout: this.config.timeoutMs });
      const available = new Set(listed.tools.map((tool) => tool.name));
      const missing = OPS_MCP_TOOL_NAMES.filter((name) => !available.has(name));
      if (missing.length > 0) {
        throw new Error(`MCP server is missing required tools: ${missing.join(", ")}`);
      }
      this.client = client;
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      this.connecting = undefined;
      throw error;
    }
  }
}
