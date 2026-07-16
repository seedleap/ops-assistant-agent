import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OpsMcpCallResult, OpsMcpToolCaller, OpsMcpToolName } from "./mcp-client.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function resultText(result: OpsMcpCallResult): string {
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  const text = result.content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  if (text) return text;
  throw new Error("MCP tool returned no text or structured content");
}

async function runOpsQuery(
  client: OpsMcpToolCaller,
  toolName: OpsMcpToolName,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  try {
    const result = await client.callTool(toolName, args);
    const text = resultText(result);
    const ok = !result.isError;
    return {
      content: [{ type: "text", text }],
      details: {
        ok,
        transport: "mcp",
        toolName,
        durationMs: Date.now() - startedAt,
        ...(!ok ? { error: text } : {}),
      },
      isError: !ok,
    };
  } catch (err) {
    const traceError = err instanceof Error ? err.message : String(err);
    const text = JSON.stringify({ ok: false, error: "运营数据服务暂时不可用，请稍后重试。" });
    return {
      content: [{ type: "text", text }],
      details: {
        ok: false,
        transport: "mcp",
        toolName,
        durationMs: Date.now() - startedAt,
        error: traceError,
      },
      isError: true,
    };
  }
}

export function createCreatorWorksTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "query_creator_works",
    label: "查创作者作品列表",
    description:
      "按 UID 查询某个创作者名下的作品列表（pid、标题、玩法、发布状态、首发时间）。" +
      "用户只给了 UID、想知道 ta 有哪些作品时用这个，再从结果里挑 PID 做下一步细查。",
    parameters: Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128, description: "创作者用户 ID。" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "返回作品数，默认 20，上限 200。" })),
      publicOnly: Type.Optional(Type.Boolean({ description: "只看已公开作品。" })),
    }),
    execute: async (_id, params) => {
      const p = params as { uid: string; limit?: number; publicOnly?: boolean };
      return runOpsQuery(client, "query_creator_works", p);
    },
  };
}

export function createWorkProfileTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "query_work_profile",
    label: "查作品画像",
    description:
      "按 PID 查询单个作品的基础画像：标题、作者 UID、发布状态、类型、原创/remix、玩法/画风/主题等标签、质量等级、创建与首发时间。" +
      "传 uid 可顺带校验作品是否属于该创作者。",
    parameters: Type.Object({
      pid: Type.String({ minLength: 1, maxLength: 128, description: "作品 / 项目 ID。" }),
      uid: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "可选：校验归属的创作者 UID。" })),
    }),
    execute: async (_id, params) => {
      const p = params as { pid: string; uid?: string };
      return runOpsQuery(client, "query_work_profile", p);
    },
  };
}

export function createWorkConsumptionTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "query_work_consumption",
    label: "查作品消费数据",
    description:
      "按 PID 查询单个作品的逐日消费结果（看板口径 UTC+8）：曝光 VV、观看人数、播放、10s 播放、时长、点赞、评论、收藏，并给出窗口汇总和转化率。" +
      "默认查最近 7 天（截止昨天）；也可用 days 或 start/end 指定窗口。回答“数据怎么样/涨没涨/消费如何”用这个。",
    parameters: Type.Object({
      pid: Type.String({ minLength: 1, maxLength: 128, description: "作品 / 项目 ID。" }),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "最近 N 天，默认 7，截止昨天。" })),
      start: Type.Optional(Type.String({ pattern: "^\\d{8}$", description: "起始日 yyyymmdd，与 end 搭配。" })),
      end: Type.Optional(Type.String({ pattern: "^\\d{8}$", description: "结束日 yyyymmdd。" })),
    }),
    execute: async (_id, params) => {
      const p = params as { pid: string; days?: number; start?: string; end?: string };
      return runOpsQuery(client, "query_work_consumption", p);
    },
  };
}

export function createWorkCommentsTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "query_work_comments",
    label: "查作品评论",
    description:
      "按 PID 查询单个作品的评论。sort=hot 取高赞评论，sort=latest 取最新评论（可达 100+ 条）。" +
      "默认只看主评论、已过审。回答“评论怎么说/高赞评论/最新反馈”用这个。",
    parameters: Type.Object({
      pid: Type.String({ minLength: 1, maxLength: 128, description: "作品 / 项目 ID。" }),
      sort: Type.Optional(
        Type.Union([Type.Literal("hot"), Type.Literal("latest")], { description: "hot=按赞，latest=按时间。默认 hot。" }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "返回条数，默认 100，上限 200。" })),
      includeReplies: Type.Optional(Type.Boolean({ description: "是否包含楼中楼回复，默认否。" })),
    }),
    execute: async (_id, params) => {
      const p = params as { pid: string; sort?: string; limit?: number; includeReplies?: boolean };
      return runOpsQuery(client, "query_work_comments", p);
    },
  };
}

export function createWorkPromptTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "query_work_prompt",
    label: "查作品创作历程",
    description:
      "按 PID 查询作品的创作历程：每一轮『用户 prompt』+『agent 实际做了什么(agent_response)』，按轮次排列" +
      "（round 1 是初始 prompt，最后一轮最接近当前形态）。" +
      "想了解作品做了哪些功能、是怎么做出来的、可能存在什么问题时用这个；" +
      "再配合 query_work_comments 的口碑，就能给出有依据的优化方向。",
    parameters: Type.Object({
      pid: Type.String({ minLength: 1, maxLength: 128, description: "作品 / 项目 ID。" }),
      rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "返回多少个创作轮次，默认 5。" })),
      full: Type.Optional(Type.Boolean({ description: "是否返回 agent 回复全文（默认截断）。" })),
    }),
    execute: async (_id, params) => {
      const p = params as { pid: string; rounds?: number; full?: boolean };
      return runOpsQuery(client, "query_work_prompt", p);
    },
  };
}

export function createWorkOverviewTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "query_work_overview",
    label: "查作品全景概览",
    description:
      "按 PID 一次性拉齐作品的画像 + 最近消费概览 + 高赞评论 Top5 + 初始 prompt。" +
      "用户笼统问“帮我看看这个作品 / 这个 pid 怎么样”时，先用这个拿全貌，再按需细查。",
    parameters: Type.Object({
      pid: Type.String({ minLength: 1, maxLength: 128, description: "作品 / 项目 ID。" }),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "消费概览窗口天数，默认 7。" })),
    }),
    execute: async (_id, params) => {
      const p = params as { pid: string; days?: number };
      return runOpsQuery(client, "query_work_overview", p);
    },
  };
}

export function createOpsDataTools(client: OpsMcpToolCaller): ToolDefinition[] {
  return [
    createWorkOverviewTool(client),
    createCreatorWorksTool(client),
    createWorkProfileTool(client),
    createWorkConsumptionTool(client),
    createWorkCommentsTool(client),
    createWorkPromptTool(client),
  ];
}
