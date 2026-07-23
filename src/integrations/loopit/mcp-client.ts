import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const OPS_MCP_TOOL_NAMES = [
  "query_work_overview",
  "query_creator_works",
  "query_work_profile",
  "query_work_consumption",
  "query_work_comments",
  "query_work_prompt",
  "analyze_work_comments",
  "query_public_work",
  "query_creator_account_summary",
  "query_creator_activity_status",
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

/*
 * 进程内只维护一个只读 Loopit MCP 连接，并按需建立。
 * 这样 dry-run 和本地 HTTP 测试不需要依赖远程数据服务，首次真实查询时才校验工具清单。
 */
export class RemoteOpsMcpClient implements OpsMcpToolCaller {
  private client?: Client;
  private connecting?: Promise<Client>;
  private availableTools?: ReadonlySet<string>;

  constructor(private readonly config: OpsMcpClientConfig) {}

  async callTool(name: OpsMcpToolName, args: Record<string, unknown>): Promise<OpsMcpCallResult> {
    const client = await this.connect();
    if (!this.availableTools?.has(name)) {
      throw new Error(`MCP server does not provide tool: ${name}`);
    }
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
    this.availableTools = undefined;
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
        this.availableTools = undefined;
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
      // Tool contracts are rolled out independently. Keep existing scenarios available
      // when a newly introduced creator-support tool has not reached the MCP service yet;
      // fail only the requested capability with an explicit diagnostic.
      this.availableTools = new Set(listed.tools.map((tool) => tool.name));
      this.client = client;
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      this.connecting = undefined;
      throw error;
    }
  }
}
