import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { rateLimit } from "express-rate-limit";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { queryLoopitData } from "./loopitDataGateway.js";
import type { OpsAssistant } from "./agent/assistant.js";
import { MODEL_OPTIONS } from "./agent/models.js";
import { listAgentProfiles, resolveAgentProfileById } from "./agent/profiles/registry.js";
import type { AgentProfileId } from "./agent/profiles/types.js";
import type { OutreachScheduler } from "./scheduler.js";
import { createId, DEFAULT_THREAD_ID, JsonStore } from "./store.js";
import { createAuthentication } from "./http/security.js";
import {
  deleteDoc,
  isCollection,
  isValidDocName,
  KNOWLEDGE_COLLECTIONS,
  listDocs,
  readDoc,
  writeDoc,
} from "./knowledge.js";

export interface AppDependencies {
  config: AppConfig;
  store: JsonStore;
  assistant: OpsAssistant;
  scheduler: OutreachScheduler;
  logger: Logger;
}

export function createApp({ config, store, assistant, scheduler, logger }: AppDependencies): express.Express {
const app = express();
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
  userId: z.string().min(1),
  imThreadId: z.string().min(1).optional(),
  text: z.string().min(1),
  reply: z.boolean().optional().default(false),
  creatorUid: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const scheduleSchema = z.object({
  userId: z.string().min(1),
  imThreadId: z.string().min(1).optional(),
  name: z.string().min(1),
  prompt: z.string().min(1),
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
  res.json({ models, default: config.agentProfiles.creatorChat.modelId });
});

const profileIdSchema = z.enum(["creator-chat", "creator-outreach"]);
const contentSchema = z.object({ content: z.string().trim().min(1).max(100_000) });

function profilePromptFile(id: AgentProfileId): string {
  return resolveAgentProfileById(config, id).systemPromptFile;
}

async function sendSystemPrompt(id: AgentProfileId, res: express.Response, next: express.NextFunction): Promise<void> {
  try {
    const content = await readFile(profilePromptFile(id), "utf8").catch(() => "");
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
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
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
    promptVersion: profile.promptVersion,
    model: {
      provider: profile.provider,
      modelId: profile.modelId,
      thinkingLevel: profile.thinkingLevel,
      temperature: profile.temperature,
    },
    runtime: {
      maxTurns: profile.maxTurns,
      timeoutMs: profile.timeoutMs,
      maxRetries: profile.maxRetries,
      compactionEnabled: profile.compactionEnabled,
    },
    toolNames: profile.toolNames,
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function writeJsonArray(file: string, items: unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(items, null, 2) + "\n", "utf8");
}
const itemsSchema = z.object({ items: z.array(z.record(z.string(), z.any())) });

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

app.post("/im/messages", async (req, res, next) => {
  try {
    const input = messageSchema.parse(req.body);
    const imThreadId = input.imThreadId || DEFAULT_THREAD_ID;
    const { conversation, previousLastUserMessageAt, message } = await store.recordUserMessage({
      userId: input.userId,
      imThreadId,
      text: input.text,
    });

    if (!input.reply) {
      res.json({ message, reply: null });
      return;
    }

    const now = new Date();
    const previousLastUserMs = previousLastUserMessageAt ? new Date(previousLastUserMessageAt).getTime() : 0;
    const shouldStartNew = !conversation.currentInteractiveSessionDir ||
      !previousLastUserMessageAt ||
      (now.getTime() - previousLastUserMs) / 60_000 >= config.interactiveSessionTimeoutMinutes;
    const runId = createId("run");
    const sessionDir = shouldStartNew
      ? join(config.dataDir, "pi-sessions", "interactive", runId)
      : conversation.currentInteractiveSessionDir!;
    const workDir = join(config.dataDir, "workspaces", input.userId, imThreadId, "interactive");

    await store.beginRun({
      id: runId,
      type: "interactive",
      userId: input.userId,
      imThreadId,
      sessionDir,
      input: input.text,
    });

    const output = await assistant.run({
      type: "interactive",
      userId: input.userId,
      imThreadId,
      runId,
      prompt: input.text,
      workDir,
      sessionDir,
      continueSession: !shouldStartNew,
      creatorUid: input.creatorUid,
      model: input.model,
    });

    await store.finishRun(runId, { status: "completed", output });
    await store.setInteractiveSessionDir(input.userId, imThreadId, sessionDir);
    const assistantMessage = await store.recordAssistantMessage({
      userId: input.userId,
      imThreadId,
      text: output,
      sourceRunId: runId,
    });

    res.json({ message, reply: assistantMessage, sessionPolicy: shouldStartNew ? "new_session" : "continue_session" });
  } catch (err) {
    next(err);
  }
});

// 流式对话：边跑边把 agent 的过程(工具调用)和回复文本推给前端 IM 页面。
app.post("/im/stream", async (req, res, next) => {
  let input: z.infer<typeof messageSchema>;
  try {
    input = messageSchema.parse(req.body);
  } catch (err) {
    next(err);
    return;
  }

  const imThreadId = input.imThreadId || DEFAULT_THREAD_ID;
  const { conversation, previousLastUserMessageAt } = await store.recordUserMessage({
    userId: input.userId,
    imThreadId,
    text: input.text,
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.on("error", () => {}); // 客户端刷新/断开时，别让 res 的 error 冒泡崩进程
  // 客户端断开也不影响：agent 仍会跑完并把回复存进 store（前端刷新后可捞回）
  const send = (event: unknown) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* 客户端可能已断开，忽略 */
    }
  };

  const now = new Date();
  const previousLastUserMs = previousLastUserMessageAt ? new Date(previousLastUserMessageAt).getTime() : 0;
  const shouldStartNew = !conversation.currentInteractiveSessionDir ||
    !previousLastUserMessageAt ||
    (now.getTime() - previousLastUserMs) / 60_000 >= config.interactiveSessionTimeoutMinutes;
  const runId = createId("run");
  const sessionDir = shouldStartNew
    ? join(config.dataDir, "pi-sessions", "interactive", runId)
    : conversation.currentInteractiveSessionDir!;
  const workDir = join(config.dataDir, "workspaces", input.userId, imThreadId, "interactive");

  await store.beginRun({
    id: runId,
    type: "interactive",
    userId: input.userId,
    imThreadId,
    sessionDir,
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
        sessionDir,
        continueSession: !shouldStartNew,
        creatorUid: input.creatorUid,
        model: input.model,
      },
      (event) => send(event),
    );

    await store.finishRun(runId, { status: "completed", output });
    await store.setInteractiveSessionDir(input.userId, imThreadId, sessionDir);
    const assistantMessage = await store.recordAssistantMessage({
      userId: input.userId,
      imThreadId,
      text: output,
      sourceRunId: runId,
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
