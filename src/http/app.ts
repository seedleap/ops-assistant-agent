import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { rateLimit } from "express-rate-limit";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ConversationRecord, SessionMode } from "../domain/types.js";
import { queryLoopitData } from "../integrations/loopit/local-gateway.js";
import type { OpsAssistant } from "../agent/assistant.js";
import { MODEL_OPTIONS } from "../agent/models.js";
import { listAgentProfiles, resolveAgentProfileById } from "../agent/profiles/registry.js";
import { isAgentProfileId, type AgentProfileId } from "../agent/profiles/catalog.js";
import type { OutreachScheduler } from "../infrastructure/scheduler/outreach-scheduler.js";
import { createId, DEFAULT_THREAD_ID, JsonStore } from "../infrastructure/persistence/json-store.js";
import { createAuthentication } from "../http/security.js";
import { KeyedMutex } from "../concurrency/keyedMutex.js";
import { writeFileAtomic } from "../runtime/atomic-file.js";
import { conversationKey, conversationWorkDir } from "../runtime/paths.js";
import { ConversationArchiveStore } from "../infrastructure/persistence/conversation-archive.js";
import {
  deleteDoc,
  isCollection,
  isValidDocName,
  KNOWLEDGE_COLLECTIONS,
  listDocs,
  readDoc,
  writeDoc,
} from "../integrations/knowledge/service.js";

export interface AppDependencies {
  config: AppConfig;
  store: JsonStore;
  assistant: OpsAssistant;
  scheduler: OutreachScheduler;
  logger: Logger;
}

interface InteractiveSessionDecision {
  sessionId: string;
  sessionDir: string;
  continueSession: boolean;
  contextBootstrap?: string;
}

async function prepareInteractiveSession(
  store: JsonStore,
  config: AppConfig,
  conversation: ConversationRecord,
  userId: string,
  imThreadId: string,
  mode: SessionMode,
  previousLastUserMessageAt?: string,
): Promise<InteractiveSessionDecision> {
  const stale = previousLastUserMessageAt
    ? (Date.now() - new Date(previousLastUserMessageAt).getTime()) / 60_000 >= config.interactiveSessionTimeoutMinutes
    : true;
  const requestedNew = mode === "new" || stale || !conversation.currentInteractiveSessionDir;
  const existingDir = conversation.currentInteractiveSessionDir;
  const canContinue = !requestedNew && !!existingDir && existsSync(existingDir);
  if (canContinue) {
    const sessionId = conversation.activeSessionId || createId("sess");
    if (!conversation.activeSessionId) {
      await store.createSession({ id: sessionId, userId, imThreadId, type: "interactive", sessionDir: existingDir! });
    }
    return { sessionId, sessionDir: existingDir!, continueSession: true };
  }

  const sessionId = createId("sess");
  const sessionDir = join(config.dataDir, "pi-sessions", "interactive", sessionId);
  const contextBootstrap = store.buildRecoveryContext(userId, imThreadId, conversation.activeSessionId);
  await store.createSession({ id: sessionId, userId, imThreadId, type: "interactive", sessionDir });
  return {
    sessionId,
    sessionDir,
    continueSession: false,
    ...(contextBootstrap ? { contextBootstrap } : {}),
  };
}

/*
 * 这里只负责 HTTP 协议层：解析请求、鉴权、返回响应。
 * 聊天运行、会话持久化和调度决策仍由下层对象完成，避免路由直接实现业务规则。
 */
export function createApp({ config, store, assistant, scheduler, logger }: AppDependencies): express.Express {
const app = express();
const conversationMutex = new KeyedMutex();
const conversationArchive = new ConversationArchiveStore(config.conversationArchive ?? {
  enabled: false,
  prefix: "ops-conversations",
});
const archiveConversation = async (userId: string, imThreadId: string): Promise<void> => {
  const state = store.snapshot();
  const conversation = state.conversations.find((item) => item.userId === userId && item.imThreadId === imThreadId);
  if (!conversation) return;
  await conversationArchive.put({
    conversation,
    sessions: state.sessions.filter((item) => item.userId === userId && item.imThreadId === imThreadId),
    messages: state.messages.filter((item) => item.userId === userId && item.imThreadId === imThreadId),
  });
};
const hydrateConversation = async (userId: string, imThreadId: string): Promise<void> => {
  if (store.getConversation(userId, imThreadId)) return;
  const archived = await conversationArchive.get(userId, imThreadId);
  if (archived) await store.restoreConversationArchive(archived);
};
app.disable("x-powered-by");
if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);
app.use(pinoHttp({ logger }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: config.corsOrigins,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));
app.use(express.json({ limit: "1mb" }));
if (config.staticUiEnabled) app.use(express.static(config.publicDir));

const messageSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  imThreadId: z.string().trim().min(1).max(128).optional(),
  text: z.string().trim().min(1).max(100_000),
  reply: z.boolean().optional().default(false),
  creatorUid: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  sessionMode: z.enum(["continue", "new"]).optional().default("continue"),
});

const scheduleSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  imThreadId: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  intervalMinutes: z.number().int().positive(),
  silentMinutes: z.number().int().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

const dataQuerySchema = z.object({
  uid: z.string().min(1).optional(),
  pid: z.string().min(1).optional(),
  include: z.array(z.enum(["projects", "profile", "consumption", "prompt", "comments"])).optional(),
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
  sortBy: z.enum(["latest", "hot"]).optional(),
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: "draft-8",
  legacyHeaders: false,
}));
app.use(createAuthentication(config));

app.get("/state", (_req, res) => {
  res.json(store.snapshot());
});

// 某个会话(userId+imThreadId)按时间顺序的消息——前端刷新后用来捞回没显示的 agent 回复
app.get("/im/messages", (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  const imThreadId = typeof req.query.imThreadId === "string" ? req.query.imThreadId : "";
  const messages = store.snapshot().messages.filter(
    (m) => m.userId === userId && m.imThreadId === imThreadId,
  );
  res.json({ messages });
});

// ---- 可选模型列表（前端下拉用，对比价格/效果） ----
app.get("/config/models", (_req, res) => {
  const models = MODEL_OPTIONS.filter((model) => config.modelWhitelist.includes(`${model.provider}/${model.id}`));
  res.json({ models, default: resolveAgentProfileById(config, "creator-chat").model.modelId });
});

const profileIdSchema = z.custom<AgentProfileId>(
  (value) => typeof value === "string" && isAgentProfileId(value),
);
const contentSchema = z.object({ content: z.string().trim().min(1).max(100_000) });

function profilePromptFile(id: AgentProfileId): string {
  return resolveAgentProfileById(config, id).prompt.file;
}

async function sendSystemPrompt(id: AgentProfileId, res: express.Response, next: express.NextFunction): Promise<void> {
  try {
    const content = await readFile(profilePromptFile(id), "utf8");
    res.json({ profileId: id, content });
  } catch (err) {
    next(err);
  }
}

async function saveSystemPrompt(
  id: AgentProfileId,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  try {
    const { content } = contentSchema.parse(req.body);
    const file = profilePromptFile(id);
    await writeFileAtomic(file, content);
    res.json({ ok: true, profileId: id });
  } catch (err) {
    next(err);
  }
}

app.get("/config/agent-profiles", (_req, res) => {
  const profiles = listAgentProfiles(config).map((profile) => ({
    id: profile.id,
    runType: profile.runType,
    traceName: profile.traceName,
    promptVersion: profile.prompt.version,
    model: profile.model,
    runtime: profile.runtime,
    toolNames: profile.toolNames,
    localSkills: profile.localSkills ?? [],
    skills: profile.skills ?? [],
  }));
  res.json({ profiles });
});

app.get("/config/agent-profiles/:id/system-prompt", (req, res, next) => {
  const parsed = profileIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(404).json({ error: "unknown agent profile" });
    return;
  }
  void sendSystemPrompt(parsed.data, res, next);
});

app.put("/config/agent-profiles/:id/system-prompt", (req, res, next) => {
  const parsed = profileIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(404).json({ error: "unknown agent profile" });
    return;
  }
  void saveSystemPrompt(parsed.data, req, res, next);
});

// Creator chat alias retained for the current lightweight configuration UI.
app.get("/config/system-prompt", (_req, res, next) => {
  void sendSystemPrompt("creator-chat", res, next);
});
app.put("/config/system-prompt", (req, res, next) => {
  void saveSystemPrompt("creator-chat", req, res, next);
});

// ---- 知识库（创作者指导 / 运营活动）子文档增删改查 ----
app.get("/skills/:collection/docs", async (req, res, next) => {
  try {
    const collection = req.params.collection;
    if (!isCollection(collection)) {
      res.status(404).json({ error: `unknown collection: ${collection}` });
      return;
    }
    res.json({
      collection,
      label: KNOWLEDGE_COLLECTIONS[collection].label,
      docs: await listDocs(config.skillsDir, collection),
    });
  } catch (err) {
    next(err);
  }
});

app.get("/skills/:collection/docs/:name", async (req, res, next) => {
  try {
    const collection = req.params.collection;
    if (!isCollection(collection)) {
      res.status(404).json({ error: "unknown collection" });
      return;
    }
    if (!isValidDocName(req.params.name)) {
      res.status(400).json({ error: "invalid doc name" });
      return;
    }
    const content = await readDoc(config.skillsDir, collection, req.params.name).catch(() => null);
    if (content === null) {
      res.status(404).json({ error: "doc not found" });
      return;
    }
    res.json({ name: req.params.name, content });
  } catch (err) {
    next(err);
  }
});

app.put("/skills/:collection/docs/:name", async (req, res, next) => {
  try {
    const collection = req.params.collection;
    if (!isCollection(collection)) {
      res.status(404).json({ error: "unknown collection" });
      return;
    }
    if (!isValidDocName(req.params.name)) {
      res.status(400).json({ error: "invalid doc name (只允许字母/数字/下划线/连字符)" });
      return;
    }
    const { content } = contentSchema.parse(req.body);
    await writeDoc(config.skillsDir, collection, req.params.name, content);
    res.json({ ok: true, name: req.params.name });
  } catch (err) {
    next(err);
  }
});

app.delete("/skills/:collection/docs/:name", async (req, res, next) => {
  try {
    const collection = req.params.collection;
    if (!isCollection(collection)) {
      res.status(404).json({ error: "unknown collection" });
      return;
    }
    const removed = await deleteDoc(config.skillsDir, collection, req.params.name);
    res.json({ ok: removed });
  } catch (err) {
    next(err);
  }
});

// ---- 用户分层 & 定时任务：整数组配置（前端管理后整组保存） ----
async function readJsonArray(file: string): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`配置文件必须是数组: ${file}`);
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
async function writeJsonArray(file: string, items: unknown[]): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(items, null, 2) + "\n");
}
const itemsSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())).max(1_000) });

app.get("/config/segments", async (_req, res, next) => {
  try {
    res.json({ items: await readJsonArray(config.segmentsFile) });
  } catch (err) {
    next(err);
  }
});
app.put("/config/segments", async (req, res, next) => {
  try {
    const { items } = itemsSchema.parse(req.body);
    await writeJsonArray(config.segmentsFile, items);
    res.json({ ok: true, count: items.length });
  } catch (err) {
    next(err);
  }
});

app.get("/config/scheduled-tasks", async (_req, res, next) => {
  try {
    res.json({ items: await readJsonArray(config.scheduledTasksFile) });
  } catch (err) {
    next(err);
  }
});
app.put("/config/scheduled-tasks", async (req, res, next) => {
  try {
    const { items } = itemsSchema.parse(req.body);
    await writeJsonArray(config.scheduledTasksFile, items);
    res.json({ ok: true, count: items.length });
  } catch (err) {
    next(err);
  }
});

app.post("/data/query", async (req, res, next) => {
  try {
    const input = dataQuerySchema.parse(req.body);
    const result = await queryLoopitData(config.loopitDataFile, input);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
});

// 创作助手 MVP 的稳定入口；/im/* 保留给现有客户端兼容，二者共享同一会话和处理链路。
app.post(["/creator-assistant/messages", "/im/messages"], async (req, res, next) => {
  /*
   * 非流式和流式接口都必须按会话串行。
   * Pi 会复用同一个 session 目录，并发写入会导致上下文分叉或文件损坏。
   */
  try {
    const input = messageSchema.parse(req.body);
    const imThreadId = input.imThreadId || DEFAULT_THREAD_ID;
    await conversationMutex.runExclusive(conversationKey(input.userId, imThreadId), async () => {
      await hydrateConversation(input.userId, imThreadId);
      const { conversation, previousLastUserMessageAt, message } = await store.recordUserMessage({
        userId: input.userId,
        imThreadId,
        text: input.text,
      });

      if (!input.reply) {
        res.json({ message, reply: null });
        return;
      }

      const runId = createId("run");
      const session = await prepareInteractiveSession(
        store, config, conversation, input.userId, imThreadId, input.sessionMode, previousLastUserMessageAt,
      );
      const workDir = conversationWorkDir(config.dataDir, input.userId, imThreadId, "interactive");

      await store.beginRun({
        id: runId,
        type: "interactive",
        userId: input.userId,
        imThreadId,
        sessionDir: session.sessionDir,
        sessionId: session.sessionId,
        input: input.text,
      });

      try {
        const output = await assistant.run({
          type: "interactive",
          userId: input.userId,
          imThreadId,
          runId,
          prompt: input.text,
          workDir,
          sessionDir: session.sessionDir,
          sessionId: session.sessionId,
          sessionMode: session.continueSession ? "continue" : "new",
          continueSession: session.continueSession,
          contextBootstrap: session.contextBootstrap,
          creatorUid: input.creatorUid,
          model: input.model,
        });
        if (!output.trim()) throw new Error("Agent returned an empty response");

        await store.finishRun(runId, { status: "completed", output });
        await store.setInteractiveSessionDir(input.userId, imThreadId, session.sessionDir);
        await store.touchSession(session.sessionId, { runId });
        const assistantMessage = await store.recordAssistantMessage({
          userId: input.userId,
          imThreadId,
          text: output,
          sourceRunId: runId,
        });
        await store.updateConversationSummary(input.userId, imThreadId, session.sessionId);
        void archiveConversation(input.userId, imThreadId).catch((error) => {
          logger.warn({ err: error, userId: input.userId, imThreadId }, "conversation archive failed");
        });

        res.json({ message, reply: assistantMessage, sessionId: session.sessionId, sessionPolicy: session.continueSession ? "continue_session" : "new_session" });
      } catch (error) {
        await store.finishRun(runId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
        throw error;
      }
    });
  } catch (err) {
    next(err);
  }
});

// 流式对话：边跑边把 agent 的过程(工具调用)和回复文本推给前端 IM 页面。
app.post(["/creator-assistant/stream", "/im/stream"], async (req, res, next) => {
  let input: z.infer<typeof messageSchema>;
  try {
    input = messageSchema.parse(req.body);
  } catch (err) {
    next(err);
    return;
  }

  const imThreadId = input.imThreadId || DEFAULT_THREAD_ID;
  // 先建立 SSE 响应，排队等待同会话任务时客户端仍能保持连接。
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.on("error", () => {}); // 客户端刷新/断开时，别让 res 的 error 冒泡崩进程
  await conversationMutex.runExclusive(conversationKey(input.userId, imThreadId), async () => {
  await hydrateConversation(input.userId, imThreadId);
  const { conversation, previousLastUserMessageAt } = await store.recordUserMessage({
      userId: input.userId,
      imThreadId,
      text: input.text,
    });

  // 客户端断开也不影响：agent 仍会跑完并把回复存进 store（前端刷新后可捞回）
  const send = (event: unknown) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* 客户端可能已断开，忽略 */
    }
  };

  const runId = createId("run");
  const session = await prepareInteractiveSession(
    store, config, conversation, input.userId, imThreadId, input.sessionMode, previousLastUserMessageAt,
  );
  const workDir = conversationWorkDir(config.dataDir, input.userId, imThreadId, "interactive");

  await store.beginRun({
    id: runId,
    type: "interactive",
    userId: input.userId,
    imThreadId,
    sessionDir: session.sessionDir,
    sessionId: session.sessionId,
    input: input.text,
  });
  send({ type: "start", runId });

  try {
    const output = await assistant.run(
      {
        type: "interactive",
        userId: input.userId,
        imThreadId,
        runId,
        prompt: input.text,
        workDir,
        sessionDir: session.sessionDir,
        sessionId: session.sessionId,
        sessionMode: session.continueSession ? "continue" : "new",
        continueSession: session.continueSession,
        contextBootstrap: session.contextBootstrap,
        creatorUid: input.creatorUid,
        model: input.model,
      },
      (event) => send(event),
    );

    await store.finishRun(runId, { status: "completed", output });
    await store.setInteractiveSessionDir(input.userId, imThreadId, session.sessionDir);
    const assistantMessage = await store.recordAssistantMessage({
      userId: input.userId,
      imThreadId,
      text: output,
      sourceRunId: runId,
    });
    await store.touchSession(session.sessionId, { runId });
    await store.updateConversationSummary(input.userId, imThreadId, session.sessionId);
    void archiveConversation(input.userId, imThreadId).catch((error) => {
      logger.warn({ err: error, userId: input.userId, imThreadId }, "conversation archive failed");
    });
    send({ type: "done", reply: assistantMessage });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await store.finishRun(runId, { status: "failed", error: messageText }).catch(() => {});
    send({ type: "error", message: messageText });
  } finally {
    res.end();
  }
  });
});

app.post("/schedules", async (req, res, next) => {
  try {
    const input = scheduleSchema.parse(req.body);
    const schedule = await store.createSchedule({
      userId: input.userId,
      imThreadId: input.imThreadId,
      name: input.name,
      prompt: input.prompt,
      intervalMinutes: input.intervalMinutes,
      silentMinutes: input.silentMinutes ?? config.defaultOutreachSilentMinutes,
      enabled: input.enabled,
    });
    res.status(201).json({ schedule });
  } catch (err) {
    next(err);
  }
});

app.get("/schedules", (_req, res) => {
  res.json({ schedules: store.listSchedules() });
});

app.post("/scheduler/tick", async (_req, res, next) => {
  try {
    const results = await scheduler.tick();
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

app.get("/outbox", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ outbox: store.listOutbox(status as any) });
});

app.post("/outbox/:id/deliver", async (req, res, next) => {
  try {
    const item = await store.markOutboxDelivered(req.params.id);
    if (!item) {
      res.status(404).json({ error: "outbox item not found" });
      return;
    }
    res.json({ outbox: item });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "invalid request", details: err.flatten() });
    return;
  }
  if (typeof err === "object" && err && "name" in err && err.name === "UnauthorizedError") {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  _req.log.error({ err }, "unhandled request error");
  res.status(500).json({
    error: config.nodeEnv === "production"
      ? "internal server error"
      : err instanceof Error ? err.message : String(err),
  });
});
return app;
}
