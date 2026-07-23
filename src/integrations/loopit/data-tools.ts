import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OpsMcpCallResult, OpsMcpToolCaller, OpsMcpToolName } from "./mcp-client.js";
import { CREATOR_SUPPORT_TOOL_BINDINGS } from "./tool-catalog.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

const responseFormatParameter = Type.Optional(
  Type.Union([Type.Literal("concise"), Type.Literal("detailed")], {
    description:
      "返回粒度。concise 只返回回答当前问题所需事实，默认使用；detailed 仅在后续分析确实需要指标明细或技术 ID 时使用。",
  }),
);

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

export function createCreatorWorkResolverTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_work_resolve",
    label: "定位创作者本人作品",
    description:
      "当用户没有提供明确 PID，只说“最近那条”“关于某主题的作品”或要求从本人作品中选择时使用。" +
      "返回少量按发布时间排序的本人作品候选，供 Agent 消歧后再调用 creator_work_analyze 或 creator_comments_analyze。" +
      "如果用户已经提供 PID，不要调用本工具。" +
      "本工具只定位作品，不返回完整分析、评论聚类或他人作品数据。",
    parameters: Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128, description: "当前创作者 UID。" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "候选数量，默认 5。" })),
      publicOnly: Type.Optional(Type.Boolean({ description: "是否仅返回已公开作品，默认 true。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_work_resolve, params as Record<string, unknown>),
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

export function createWorkAnalysisTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_work_analyze",
    label: "分析创作者本人作品",
    description:
      "当用户要复盘自己的某个作品、询问表现原因或需要优化建议时使用。" +
      "一次返回作品画像、发布后最多 14 天的核心指标、五维分析、匿名同类基线、口径和数据时间，避免 Agent 连续拼接多个底层查询。" +
      "必须同时传 uid 与 pid，由服务端校验作品归属。" +
      "不要用于评论主题分析、账号总览或他人作品；这些场景分别使用对应工具。",
    parameters: Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128, description: "当前创作者 UID，用于归属校验。" }),
      pid: Type.String({ minLength: 1, maxLength: 128, description: "待分析作品 PID。" }),
      windowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 14, description: "发布后窗口，默认 14 天。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_work_analyze, params as Record<string, unknown>),
  };
}

export function createCommentAnalysisTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_comments_analyze",
    label: "分析本人作品评论",
    description:
      "当用户明确询问本人作品的评论反馈、玩家主要观点或评论中的改进机会时使用。" +
      "服务端校验作品归属，评论较少时总结可用样本，评论较多时返回 3-7 个聚类话题、代表性评论 ID 和数据时间。" +
      "不要用它分析他人作品，也不要把评论聚类当作作品整体表现结论。" +
      "默认返回高信号摘要，只有需要核验代表性样本时才请求 detailed。",
    parameters: Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128, description: "当前创作者 UID，用于归属校验。" }),
      pid: Type.String({ minLength: 1, maxLength: 128, description: "本人作品 PID。" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "最大评论样本数，默认 200。" })),
      maxTopics: Type.Optional(Type.Integer({ minimum: 3, maximum: 7, description: "最大话题数，默认 5。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_comments_analyze, params as Record<string, unknown>),
  };
}

export function createPublicWorkTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_public_work_inspect",
    label: "学习他人公开作品",
    description:
      "当用户提供他人作品并询问玩法、使用了什么公开资源或有哪些可借鉴方法时使用。" +
      "只返回公开标题、描述、表现、Power、Hashtag 和可公开评论摘要。" +
      "不会返回或推断原始上传素材、私人 Power、完整 Prompt、作品源码或其他私有字段。" +
      "如果作品属于当前用户，应改用 creator_work_analyze。",
    parameters: Type.Object({
      pid: Type.String({ minLength: 1, maxLength: 128, description: "公开作品 PID。" }),
      viewerUid: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "当前查看者 UID，用于权限审计。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_public_work_inspect, params as Record<string, unknown>),
  };
}

export function createCreatorAccountSummaryTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_account_summarize",
    label: "汇总创作者账号表现",
    description:
      "当用户询问账号最近整体表现、趋势变化或哪些作品贡献最大时使用。" +
      "返回近 7 日逐日发布、VV、3s 率、互动、Remix、涨粉、匿名同层基线，以及近半年作品中的新增 VV Top3。" +
      "结果必须包含口径和 as_of；内部 Level 只用于计算匿名参考值，不可展示给用户。" +
      "不要用它回答单个作品原因、评论主题或活动资格。",
    parameters: Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128, description: "当前创作者 UID。" }),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "汇总窗口，默认 7 天。" })),
      topWorksLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "新增 VV 作品榜数量，默认 3。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_account_summarize, params as Record<string, unknown>),
  };
}

export function createCreatorInspirationContextTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_inspiration_context",
    label: "查创作者灵感上下文",
    description:
      "当用户想要个性化灵感，但尚未给出足够创作偏好时使用。" +
      "返回最近创作以及最近点赞、收藏、评论的必要公开内容摘要，用于形成后续目录检索条件。" +
      "只返回高信号标签和摘要，不返回内部画像、Creator Score 或不必要的个人信息。" +
      "它不直接搜索活动和创作资源；得到上下文后再调用 creator_catalog_search。",
    parameters: Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128, description: "当前创作者 UID。" }),
      recentWorksLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最近创作数量，默认 10。" })),
      recentInteractionsLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最近互动内容数量，默认 10。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_inspiration_context, params as Record<string, unknown>),
  };
}

export function createCreationCatalogSearchTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_catalog_search",
    label: "搜活动与创作素材目录",
    description:
      "当用户需要活动、作品、Power、Template 或 Hashtag 灵感时使用，可结合 creator_inspiration_context 形成检索词。" +
      "只返回当前有效且可公开的目录结果、官方入口、有效期和相关性依据，并限制结果数量以节省上下文。" +
      "搜索结果只证明资源存在，不证明当前用户具有活动资格。" +
      "准备推荐活动或回答任务状态前，必须再调用 creator_activity_status。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500, description: "基于用户意图生成的搜索语句。" }),
      types: Type.Optional(Type.Array(Type.Union([
        Type.Literal("activity"),
        Type.Literal("work"),
        Type.Literal("power"),
        Type.Literal("template"),
        Type.Literal("hashtag"),
      ]), { minItems: 1, maxItems: 5, description: "限定目录类型。" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "返回数量，默认 10。" })),
      language: Type.Optional(Type.String({ minLength: 2, maxLength: 20, description: "用户语言。" })),
      country: Type.Optional(Type.String({ minLength: 2, maxLength: 8, description: "用户国家或地区。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_catalog_search, params as Record<string, unknown>),
  };
}

export function createCreatorActivityStatusTool(client: OpsMcpToolCaller): ToolDefinition {
  return {
    name: "creator_activity_status",
    label: "查活动资格与任务状态",
    description:
      "当用户询问活动资格、报名、任务进度或奖励，或者主动触达准备发送活动消息时使用。" +
      "从活动运营中台返回活动有效性、资格、报名、进度、奖励、频控、静默、去重和官方 action，是这些状态的唯一权威只读来源。" +
      "Agent 只能解释结果，不能自行计算、修改、发放、补发或代领。" +
      "不要用目录搜索结果、Creator Score 或作品数据推断本工具负责的状态。",
    parameters: Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128, description: "当前创作者 UID。" }),
      campaignId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "指定活动 ID；省略时返回可展示的当前活动。" })),
      includeProgress: Type.Optional(Type.Boolean({ description: "是否返回任务进度与奖励状态，默认 true。" })),
      responseFormat: responseFormatParameter,
    }, { additionalProperties: false }),
    execute: async (_id, params) =>
      runOpsQuery(client, CREATOR_SUPPORT_TOOL_BINDINGS.creator_activity_status, params as Record<string, unknown>),
  };
}

export function createDataPrimitiveTools(client: OpsMcpToolCaller): ToolDefinition[] {
  return [
    createWorkOverviewTool(client),
    createCreatorWorksTool(client),
    createWorkProfileTool(client),
    createWorkConsumptionTool(client),
    createWorkCommentsTool(client),
    createWorkPromptTool(client),
  ];
}

export function createCreatorSupportTools(client: OpsMcpToolCaller): ToolDefinition[] {
  return [
    createCreatorWorkResolverTool(client),
    createWorkAnalysisTool(client),
    createCommentAnalysisTool(client),
    createPublicWorkTool(client),
    createCreatorAccountSummaryTool(client),
    createCreatorInspirationContextTool(client),
    createCreationCatalogSearchTool(client),
    createCreatorActivityStatusTool(client),
  ];
}

export function createOpsDataTools(client: OpsMcpToolCaller): ToolDefinition[] {
  return [
    ...createDataPrimitiveTools(client),
    ...createCreatorSupportTools(client),
  ];
}
