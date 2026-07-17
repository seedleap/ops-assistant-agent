import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Mutex } from "async-mutex";
import type {
  AssistantRunRecord,
  ConversationRecord,
  ConversationSessionRecord,
  ISODateString,
  IdeaImageResult,
  IdeaWorkflowRecord,
  MessageRecord,
  OutboxMessage,
  ScheduleRecord,
  StoreState,
} from "../../domain/types.js";
import type { ConversationArchive } from "./conversation-archive.js";

const DEFAULT_THREAD_ID = "default";

function nowIso(now = new Date()): ISODateString {
  return now.toISOString();
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function initialState(): StoreState {
  return {
    conversations: [],
    sessions: [],
    messages: [],
    schedules: [],
    runs: [],
    outbox: [],
    ideaWorkflows: [],
  };
}

function normalizeIdeaWorkflow(record: Partial<IdeaWorkflowRecord>): IdeaWorkflowRecord {
  const now = nowIso();
  return {
    id: record.id || createId("idea"),
    idempotencyKey: record.idempotencyKey || `legacy:${record.id || createId("idea")}`,
    inputHash: record.inputHash || "legacy",
    userId: record.userId || "unknown",
    projectId: record.projectId,
    status: record.status || "failed",
    stage: record.stage || "complete",
    input: record.input || {},
    ideas: (record.ideas || []).map((idea) => ({
      ...idea,
      interactionPattern: idea.interactionPattern || "other",
    })),
    checkpoints: record.checkpoints || {},
    attempt: record.attempt || 0,
    cancelRequested: record.cancelRequested || false,
    metadata: record.metadata || {
      workflowVersion: "legacy",
      promptVersion: "legacy",
      modelIds: [],
    },
    error: record.error,
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

/*
 * JsonStore 是单进程 MVP 存储，不承担多副本一致性。
 * 每次变更都通过互斥锁和临时文件替换，保证并发写入不会互相覆盖或留下半截 JSON。
 */
export class JsonStore {
  private readonly saveMutex = new Mutex();

  private constructor(
    private readonly filePath: string,
    private state: StoreState,
  ) {}

  static async open(dataDir: string): Promise<JsonStore> {
    const filePath = join(dataDir, "state.json");
    await mkdir(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      const store = new JsonStore(filePath, initialState());
      await store.save();
      return store;
    }
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreState>;
    // 兼容旧版 MVP 的 state.json：首次启动时补齐 sessions，不丢历史消息。
    return new JsonStore(filePath, {
      conversations: parsed.conversations ?? [],
      sessions: parsed.sessions ?? [],
      messages: parsed.messages ?? [],
      schedules: parsed.schedules ?? [],
      runs: parsed.runs ?? [],
      outbox: parsed.outbox ?? [],
      ideaWorkflows: (parsed.ideaWorkflows ?? []).map((record) => normalizeIdeaWorkflow(record)),
    });
  }

  snapshot(): StoreState {
    return JSON.parse(JSON.stringify(this.state)) as StoreState;
  }

  getIdeaWorkflow(id: string): IdeaWorkflowRecord | undefined {
    const workflow = this.state.ideaWorkflows.find((item) => item.id === id);
    return workflow ? structuredClone(workflow) : undefined;
  }

  async createIdeaWorkflow(record: IdeaWorkflowRecord): Promise<void> {
    this.state.ideaWorkflows.push(record);
    await this.save();
  }

  async createIdeaWorkflowIfAbsent(
    record: IdeaWorkflowRecord,
    maxActiveForUser = 2,
  ): Promise<{ record: IdeaWorkflowRecord; created: boolean; capacityExceeded?: boolean }> {
    return this.saveMutex.runExclusive(async () => {
      const existing = this.state.ideaWorkflows.find((workflow) =>
        workflow.userId === record.userId && workflow.idempotencyKey === record.idempotencyKey,
      );
      if (existing) return { record: JSON.parse(JSON.stringify(existing)) as IdeaWorkflowRecord, created: false };
      const activeForUser = this.state.ideaWorkflows.filter((workflow) =>
        workflow.userId === record.userId && ["queued", "running"].includes(workflow.status),
      ).length;
      if (activeForUser >= maxActiveForUser) {
        return {
          record: JSON.parse(JSON.stringify(record)) as IdeaWorkflowRecord,
          created: false,
          capacityExceeded: true,
        };
      }
      this.state.ideaWorkflows.push(record);
      await this.writeState();
      return { record: JSON.parse(JSON.stringify(record)) as IdeaWorkflowRecord, created: true };
    });
  }

  async updateIdeaWorkflow(
    id: string,
    update: Partial<Pick<IdeaWorkflowRecord,
      "status" | "stage" | "ideas" | "checkpoints" | "error" | "attempt" |
      "cancelRequested" | "metadata" | "startedAt" | "completedAt"
    >>,
  ): Promise<void> {
    await this.saveMutex.runExclusive(async () => {
      const workflow = this.state.ideaWorkflows.find((item) => item.id === id);
      if (!workflow) throw new Error(`Idea workflow not found: ${id}`);
      Object.assign(workflow, update, { updatedAt: nowIso() });
      await this.writeState();
    });
  }

  async updateIdeaImage(id: string, ideaId: string, image: IdeaImageResult): Promise<void> {
    await this.saveMutex.runExclusive(async () => {
      const workflow = this.state.ideaWorkflows.find((item) => item.id === id);
      if (!workflow) throw new Error(`Idea workflow not found: ${id}`);
      const idea = workflow.ideas.find((item) => item.id === ideaId);
      if (!idea) throw new Error(`Idea not found in workflow ${id}: ${ideaId}`);
      idea.image = image;
      workflow.updatedAt = nowIso();
      await this.writeState();
    });
  }

  async save(): Promise<void> {
    await this.saveMutex.runExclusive(async () => {
      await this.writeState();
    });
  }

  private async writeState(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.filePath);
  }

  getConversation(userId: string, imThreadId = DEFAULT_THREAD_ID): ConversationRecord | undefined {
    return this.state.conversations.find((c) => c.userId === userId && c.imThreadId === imThreadId);
  }

  async ensureConversation(userId: string, imThreadId = DEFAULT_THREAD_ID): Promise<ConversationRecord> {
    const existing = this.getConversation(userId, imThreadId);
    if (existing) return existing;
    const now = nowIso();
    const conversation: ConversationRecord = {
      userId,
      imThreadId,
      createdAt: now,
      updatedAt: now,
    };
    this.state.conversations.push(conversation);
    await this.save();
    return conversation;
  }

  async recordUserMessage(input: { userId: string; imThreadId?: string; text: string; createdAt?: Date }): Promise<{
    conversation: ConversationRecord;
    previousLastUserMessageAt?: string;
    message: MessageRecord;
  }> {
    const imThreadId = input.imThreadId || DEFAULT_THREAD_ID;
    const conversation = await this.ensureConversation(input.userId, imThreadId);
    const previousLastUserMessageAt = conversation.lastUserMessageAt;
    const createdAt = nowIso(input.createdAt);
    conversation.lastUserMessageAt = createdAt;
    conversation.updatedAt = createdAt;
    const message: MessageRecord = {
      id: createId("msg"),
      userId: input.userId,
      imThreadId,
      role: "user",
      text: input.text,
      createdAt,
    };
    this.state.messages.push(message);
    await this.save();
    return { conversation, previousLastUserMessageAt, message };
  }

  async recordAssistantMessage(input: {
    userId: string;
    imThreadId?: string;
    text: string;
    sourceRunId?: string;
    createdAt?: Date;
  }): Promise<MessageRecord> {
    const imThreadId = input.imThreadId || DEFAULT_THREAD_ID;
    const conversation = await this.ensureConversation(input.userId, imThreadId);
    const createdAt = nowIso(input.createdAt);
    conversation.lastAssistantMessageAt = createdAt;
    conversation.updatedAt = createdAt;
    const message: MessageRecord = {
      id: createId("msg"),
      userId: input.userId,
      imThreadId,
      role: "assistant",
      text: input.text,
      sourceRunId: input.sourceRunId,
      createdAt,
    };
    this.state.messages.push(message);
    await this.save();
    return message;
  }

  async setInteractiveSessionDir(userId: string, imThreadId: string, sessionDir: string): Promise<void> {
    const conversation = await this.ensureConversation(userId, imThreadId);
    conversation.currentInteractiveSessionDir = sessionDir;
    conversation.updatedAt = nowIso();
    await this.save();
  }

  getSession(id: string): ConversationSessionRecord | undefined {
    return this.state.sessions.find((session) => session.id === id);
  }

  async createSession(input: Omit<ConversationSessionRecord, "status" | "createdAt" | "updatedAt"> & { createdAt?: Date }): Promise<ConversationSessionRecord> {
    const now = nowIso(input.createdAt);
    const session: ConversationSessionRecord = {
      ...input,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.state.sessions.push(session);
    const conversation = await this.ensureConversation(input.userId, input.imThreadId);
    conversation.activeSessionId = session.id;
    conversation.currentInteractiveSessionDir = input.type === "interactive" ? input.sessionDir : conversation.currentInteractiveSessionDir;
    conversation.updatedAt = now;
    await this.save();
    return session;
  }

  async touchSession(sessionId: string, update: { runId?: string; summary?: string; close?: boolean }): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.updatedAt = nowIso();
    if (update.runId) session.lastRunId = update.runId;
    if (update.summary !== undefined) session.summary = update.summary;
    if (update.close) session.status = "closed";
    await this.save();
  }

  buildRecoveryContext(userId: string, imThreadId: string, sessionId?: string, maxMessages = 12): string {
    const conversation = this.getConversation(userId, imThreadId);
    const session = sessionId ? this.getSession(sessionId) : undefined;
    const messages = this.state.messages
      .filter((message) => message.userId === userId && message.imThreadId === imThreadId)
      .slice(-maxMessages);
    const lines: string[] = [];
    if (conversation?.summary) lines.push(`已有会话摘要：\n${conversation.summary}`);
    if (session?.summary && session.summary !== conversation?.summary) lines.push(`上一段会话摘要：\n${session.summary}`);
    if (messages.length > 0) {
      lines.push(`最近消息：\n${messages.map((message) => `${message.role === "user" ? "用户" : "Agent"}: ${message.text}`).join("\n")}`);
    }
    return lines.join("\n\n").slice(0, 24_000);
  }

  async updateConversationSummary(userId: string, imThreadId: string, sessionId?: string): Promise<void> {
    // 摘要只从最近可见消息重建，不能把旧 summary 再嵌套进去导致无限膨胀。
    const recent = this.state.messages
      .filter((message) => message.userId === userId && message.imThreadId === imThreadId)
      .slice(-8);
    const context = recent.length > 0
      ? `最近消息：\n${recent.map((message) => `${message.role === "user" ? "用户" : "Agent"}: ${message.text}`).join("\n")}`
      : "";
    const conversation = await this.ensureConversation(userId, imThreadId);
    conversation.summary = context.slice(0, 8_000);
    conversation.updatedAt = nowIso();
    if (sessionId) await this.touchSession(sessionId, { summary: conversation.summary });
    else await this.save();
  }

  async restoreConversationArchive(archive: ConversationArchive): Promise<void> {
    const existing = this.getConversation(archive.conversation.userId, archive.conversation.imThreadId);
    if (existing) return;
    this.state.conversations.push(archive.conversation);
    this.state.sessions.push(...archive.sessions);
    this.state.messages.push(...archive.messages);
    await this.save();
  }

  async createSchedule(input: {
    userId: string;
    imThreadId?: string;
    name: string;
    prompt: string;
    intervalMinutes: number;
    silentMinutes: number;
    enabled?: boolean;
    nextRunAt?: Date;
  }): Promise<ScheduleRecord> {
    const now = nowIso();
    const schedule: ScheduleRecord = {
      id: createId("sch"),
      userId: input.userId,
      imThreadId: input.imThreadId || DEFAULT_THREAD_ID,
      name: input.name,
      prompt: input.prompt,
      intervalMinutes: input.intervalMinutes,
      silentMinutes: input.silentMinutes,
      enabled: input.enabled ?? true,
      nextRunAt: nowIso(input.nextRunAt ?? new Date()),
      createdAt: now,
      updatedAt: now,
    };
    this.state.schedules.push(schedule);
    await this.ensureConversation(schedule.userId, schedule.imThreadId);
    await this.save();
    return schedule;
  }

  listSchedules(): ScheduleRecord[] {
    return [...this.state.schedules];
  }

  async updateScheduleTiming(scheduleId: string, update: { nextRunAt: Date; lastRunAt?: Date }): Promise<void> {
    const schedule = this.state.schedules.find((s) => s.id === scheduleId);
    if (!schedule) return;
    schedule.nextRunAt = nowIso(update.nextRunAt);
    if (update.lastRunAt) schedule.lastRunAt = nowIso(update.lastRunAt);
    schedule.updatedAt = nowIso();
    await this.save();
  }

  async beginRun(input: Omit<AssistantRunRecord, "status" | "startedAt"> & { startedAt?: Date }): Promise<AssistantRunRecord> {
    const run: AssistantRunRecord = {
      ...input,
      status: "running",
      startedAt: nowIso(input.startedAt),
    };
    this.state.runs.push(run);
    await this.save();
    return run;
  }

  async finishRun(runId: string, update: {
    status: AssistantRunRecord["status"];
    output?: string;
    reason?: string;
    error?: string;
    completedAt?: Date;
  }): Promise<void> {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) return;
    run.status = update.status;
    run.output = update.output;
    run.reason = update.reason;
    run.error = update.error;
    run.completedAt = nowIso(update.completedAt);
    await this.save();
  }

  async createOutbox(input: {
    userId: string;
    imThreadId: string;
    scheduleId: string;
    runId: string;
    text: string;
    createdAt?: Date;
  }): Promise<OutboxMessage> {
    const item: OutboxMessage = {
      id: createId("out"),
      userId: input.userId,
      imThreadId: input.imThreadId,
      scheduleId: input.scheduleId,
      runId: input.runId,
      text: input.text,
      status: "pending",
      createdAt: nowIso(input.createdAt),
    };
    this.state.outbox.push(item);
    await this.save();
    return item;
  }

  listOutbox(status?: OutboxMessage["status"]): OutboxMessage[] {
    return this.state.outbox.filter((item) => !status || item.status === status);
  }

  async markOutboxDelivered(outboxId: string, deliveredAt = new Date()): Promise<OutboxMessage | undefined> {
    const item = this.state.outbox.find((o) => o.id === outboxId);
    if (!item) return undefined;
    item.status = "delivered";
    item.deliveredAt = nowIso(deliveredAt);
    await this.recordAssistantMessage({
      userId: item.userId,
      imThreadId: item.imThreadId,
      text: item.text,
      sourceRunId: item.runId,
      createdAt: deliveredAt,
    });
    await this.save();
    return item;
  }
}

export { createId, DEFAULT_THREAD_ID };
