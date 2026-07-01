import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import { createOpsDataTools } from "./opsDataTools.js";
import { createReadKnowledgeTool, knowledgeIndex } from "./knowledge.js";
import type { AssistantRunInput } from "./types.js";
import { createListSkillDocsTool, createReadSkillDocTool } from "./tools.js";

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

/** 流式过程事件：工具调用的开始/结束 + 回复文本增量 + 本轮 token/花费。供 IM 前端展示。 */
export interface AssistantEvent {
  type: "text_delta" | "tool_start" | "tool_end" | "usage";
  delta?: string;
  tool?: string;
  ok?: boolean;
  usage?: TurnUsage;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  model?: string;
}

interface SessionTokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

// 模型自带定价(pi 的 getSessionStats().cost)优先；万一是 0，用这个每百万 token 单价兜底估算。
const PRICE_PER_1M = {
  input: Number(process.env.MODEL_PRICE_INPUT_PER_1M ?? 0.3),
  output: Number(process.env.MODEL_PRICE_OUTPUT_PER_1M ?? 2.5),
  cacheRead: Number(process.env.MODEL_PRICE_CACHE_READ_PER_1M ?? 0.075),
};

// 前端可选的模型（用来对比价格/效果）。cost 单位均为「美元/百万 token」。
export interface ModelOption {
  id: string;
  label: string;
  note: string;
}
export const MODEL_OPTIONS: ModelOption[] = [
  { id: "gemini-3-flash-preview", label: "Gemini 3.0 Flash", note: "标准 · 入 $0.5 / 出 $3 每百万tok" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", note: "轻量更省 · 入 $0.1 / 出 $0.4 每百万tok" },
];
// 注册表里没有的模型 → 克隆模板并套用这里的定价（保证按各自模型算准价）。
const PRICE_OVERRIDE: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "gemini-3.1-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
};

// 系统提示正文放在 config/system-prompt.md，可在前端编辑、运行时读取。文件缺失时用这段兜底。
const DEFAULT_SYSTEM_PROMPT = `你是 Loopit 的创作小助手，帮创作者了解自己的作品、读懂玩家、把作品做得更好。
温暖、简洁、会打气，说"你的作品"。只用工具查到的真实数据与后台知识库说话，不编数字、不杜撰活动。
聊创作技巧/Loopit 能力调 read_knowledge('creator_guide')，聊活动调 read_knowledge('ops_activities')。
做主动触达只写一条简短 IM；不值得打扰就回 NO_OUTREACH: <原因>。`;

export class PiAssistant {
  constructor(private readonly config: AppConfig) {}

  async run(input: AssistantRunInput, onEvent?: (event: AssistantEvent) => void): Promise<string> {
    if (this.config.assistantDryRun) {
      const text = this.dryRun(input);
      onEvent?.({ type: "text_delta", delta: text });
      return text;
    }
    await mkdir(input.workDir, { recursive: true });
    await mkdir(input.sessionDir, { recursive: true });
    await mkdir(dirname(this.authPath()), { recursive: true });

    const authStorage = AuthStorage.create(this.authPath());
    if (process.env.ANTHROPIC_API_KEY) {
      authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
    }
    if (process.env.OPENAI_API_KEY) {
      authStorage.setRuntimeApiKey("openai", process.env.OPENAI_API_KEY);
    }
    const modelRegistry = new ModelRegistry(authStorage);
    const model = this.resolveModel(modelRegistry, input.model);
    const modelId = (model as { id?: string } | undefined)?.id;
    const modelName = MODEL_OPTIONS.find((o) => o.id === modelId)?.label ||
      (model as { name?: string } | undefined)?.name;

    const systemPrompt = await this.composeSystemPrompt();
    const resourceLoader = this.createResourceLoader(systemPrompt);
    const sessionManager = input.continueSession && existsSync(input.sessionDir)
      ? SessionManager.continueRecent(input.workDir, input.sessionDir)
      : SessionManager.create(input.workDir, input.sessionDir);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: input.type === "interactive" },
      retry: { enabled: true, maxRetries: 2 },
    });

    const { session } = await createAgentSession({
      cwd: input.workDir,
      agentDir: this.config.dataDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "off",
      resourceLoader,
      tools: [],
      customTools: this.withEvents(
        [
          ...createOpsDataTools({
            pythonBin: this.config.pythonBin,
            scriptPath: this.config.opsQueryScript,
          }),
          createReadKnowledgeTool(this.config.skillsDir),
          createListSkillDocsTool(this.config.skillsDir),
          createReadSkillDocTool(this.config.skillsDir),
        ],
        onEvent,
      ),
      sessionManager,
      settingsManager,
    });

    const chunks: string[] = [];
    session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        const delta = String(event.assistantMessageEvent.delta || "");
        chunks.push(delta);
        onEvent?.({ type: "text_delta", delta });
      }
    });

    const statsBefore = this.readStats(session);
    try {
      await session.prompt(this.buildPrompt(input));
      this.emitUsage(statsBefore, this.readStats(session), onEvent, modelName);
      const assistantResult = this.readLastAssistantMessage(session);
      if (assistantResult.error) {
        throw new Error(assistantResult.error);
      }
      return (assistantResult.text || chunks.join("")).trim();
    } finally {
      session.dispose();
    }
  }

  /** 运行时拼系统提示：读 config/system-prompt.md（可前端编辑）+ 注入当前知识库索引。 */
  private async composeSystemPrompt(): Promise<string> {
    let base = DEFAULT_SYSTEM_PROMPT;
    try {
      const fromFile = (await readFile(this.config.systemPromptFile, "utf8")).trim();
      if (fromFile) {
        base = fromFile;
      }
    } catch {
      // 文件缺失就用兜底
    }
    let index = "";
    try {
      index = await knowledgeIndex(this.config.skillsDir);
    } catch {
      // 知识库读不到就不注入
    }
    return index ? `${base}\n\n${index}` : base;
  }

  /** 读取会话累计 token/花费统计（pi 内置），异常时返回全 0。 */
  private readStats(session: unknown): SessionTokenStats {
    const zero: SessionTokenStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    try {
      const s = session as { getSessionStats?: () => { tokens?: Partial<SessionTokenStats>; cost?: number } };
      if (typeof s.getSessionStats === "function") {
        const stats = s.getSessionStats();
        const t = stats.tokens || {};
        return {
          input: Number(t.input || 0),
          output: Number(t.output || 0),
          cacheRead: Number(t.cacheRead || 0),
          cacheWrite: Number(t.cacheWrite || 0),
          total: Number(t.total || 0),
          cost: Number(stats.cost || 0),
        };
      }
    } catch {
      // 拿不到就算了，不影响主流程
    }
    return zero;
  }

  /** 用本轮前后统计差值算出这条消息的 token 与花费，推给前端。 */
  private emitUsage(
    before: SessionTokenStats,
    after: SessionTokenStats,
    onEvent?: (event: AssistantEvent) => void,
    modelName?: string,
  ): void {
    if (!onEvent) {
      return;
    }
    const delta = (key: keyof SessionTokenStats) => Math.max(0, after[key] - before[key]);
    const inputTokens = delta("input");
    const outputTokens = delta("output");
    const cacheReadTokens = delta("cacheRead");
    const cacheWriteTokens = delta("cacheWrite");
    const totalTokens = delta("total") || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    let costUsd = Math.max(0, after.cost - before.cost);
    if (!costUsd) {
      costUsd =
        (inputTokens * PRICE_PER_1M.input +
          outputTokens * PRICE_PER_1M.output +
          cacheReadTokens * PRICE_PER_1M.cacheRead) /
        1_000_000;
    }
    onEvent({
      type: "usage",
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costUsd, model: modelName },
    });
  }

  /** 若创作者配置了 UID，给这轮消息前面带上一段背景，让 agent 知道"我的作品"指谁。 */
  private buildPrompt(input: AssistantRunInput): string {
    const uid = input.creatorUid?.trim();
    if (!uid) {
      return input.prompt;
    }
    const context = `（背景信息，不用复述：当前创作者的 UID 是 ${uid}。当 ta 说"我的作品/我的游戏"等没给出具体作品链接或 PID 时，用 query_creator_works 查这个 UID 名下的作品来回答。）`;
    return `${context}\n\n${input.prompt}`;
  }

  /** 给每个自定义工具套一层，调用前后向 onEvent 上报，让前端能展示"正在查什么"。 */
  private withEvents(
    tools: ToolDefinition[],
    onEvent?: (event: AssistantEvent) => void,
  ): ToolDefinition[] {
    if (!onEvent) {
      return tools;
    }
    return tools.map((tool) => ({
      ...tool,
      execute: async (id: string, params: unknown, signal: any, onUpdate: any, ctx: any) => {
        const label = tool.label || tool.name;
        onEvent({ type: "tool_start", tool: label });
        try {
          const result = await tool.execute(id, params, signal, onUpdate, ctx);
          onEvent({ type: "tool_end", tool: label, ok: !(result as { isError?: boolean }).isError });
          return result;
        } catch (err) {
          onEvent({ type: "tool_end", tool: label, ok: false });
          throw err;
        }
      },
    }));
  }

  private dryRun(input: AssistantRunInput): string {
    if (input.type === "outreach") {
      return `【运营提醒】这是 dry-run 触达消息：${input.prompt.slice(0, 80)}`;
    }
    return `【dry-run 回复】已收到：${input.prompt.slice(0, 120)}`;
  }

  private authPath(): string {
    return `${this.config.dataDir}/pi-auth/auth.json`;
  }

  private resolveModel(modelRegistry: ModelRegistry, requestedId?: string): PiModel | undefined {
    const provider = this.config.assistantModelProvider || "google-vertex";
    const modelId = (requestedId && requestedId.trim()) || this.config.assistantModelId;
    if (!provider || !modelId) {
      return undefined;
    }

    const found = modelRegistry.find(provider, modelId);
    const override = PRICE_OVERRIDE[modelId];
    // 注册表里有、且不需要改价 → 直接用真实模型（定价最准）。
    if (found && !override) {
      return found;
    }
    // 否则克隆一个模板，换上目标 id / 名称 / 定价，让 Vertex 按这个 id 调用。
    const template = found ||
      modelRegistry.find(provider, "gemini-3-flash-preview") ||
      modelRegistry.find(provider, "gemini-2.5-flash");
    if (!template) {
      throw new Error(`No template model available for ${provider}/${modelId}`);
    }
    const option = MODEL_OPTIONS.find((o) => o.id === modelId);
    return {
      ...template,
      id: modelId,
      name: option?.label || modelId,
      reasoning: true,
      ...(override ? { cost: override } : {}),
    };
  }

  private readLastAssistantMessage(session: { messages?: unknown[] }): { text: string; error?: string } {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index] as { message?: unknown };
      const message = (entry.message || entry) as {
        role?: string;
        content?: Array<{ type?: string; text?: unknown }>;
        stopReason?: string;
        errorMessage?: unknown;
      };
      if (message.role !== "assistant") {
        continue;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return { text: "", error: this.formatAssistantError(message.errorMessage, message.stopReason) };
      }
      const text = Array.isArray(message.content)
        ? message.content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("")
          .trim()
        : "";
      return { text };
    }
    return { text: "" };
  }

  private formatAssistantError(errorMessage: unknown, stopReason: string): string {
    const raw = typeof errorMessage === "string" && errorMessage.trim()
      ? errorMessage
      : `Assistant stopped with reason: ${stopReason}`;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") {
        return parsed.error.message;
      }
    } catch {
      // Keep the provider's raw message when it is not JSON.
    }
    return raw;
  }

  private createResourceLoader(systemPrompt: string): ResourceLoader {
    return {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
  }
}
