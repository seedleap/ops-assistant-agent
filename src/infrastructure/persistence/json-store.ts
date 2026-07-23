import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Mutex } from "async-mutex";
import type {
  AssistantRunRecord,
  ConversationRecord,
  ConversationSessionRecord,
  CreatorMemoryRecord,
  ISODateString,
  MessageRecord,
  OutboxMessage,
  ScheduleRecord,
  StoreState,
} from "../../domain/types.js";
import type { ConversationArchive } from "./conversation-archive.js";
import { buildCreatorMemory } from "./creator-memory.js";

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
    creatorMemories: [],
    sessions: [],
    messages: [],
    schedules: [],
    runs: [],
    outbox: [],
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
      creatorMemories: parsed.creatorMemories ?? [],
      sessions: parsed.sessions ?? [],
      messages: parsed.messages ?? [],
      schedules: parsed.schedules ?? [],
      runs: parsed.runs ?? [],
      outbox: parsed.outbox ?? [],
    });
  }

  snapshot(): StoreState {
    return JSON.parse(JSON.stringify(this.state)) as StoreState;
  }

  async save(): Promise<void> {
    await this.saveMutex.runExclusive(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      await rename(tmp, this.filePath);
    });
  }

  getConversation(userId: string, imThreadId = DEFAULT_THREAD_ID): ConversationRecord | undefined {
    return this.state.conversations.find((c) => c.userId === userId && c.imThreadId === imThreadId);
  }

  getCreatorMemory(userId: string): CreatorMemoryRecord | undefined {
    return this.state.creatorMemories.find((memory) => memory.userId === userId);
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

  buildRecoveryContext(userId: string, imThreadId: string, sessionId?: string): string {
    const conversation = this.getConversation(userId, imThreadId);
    const session = sessionId ? this.getSession(sessionId) : undefined;
    const memory = this.getCreatorMemory(userId);
    const lines: string[] = [];
    if (memory && (memory.stablePreferences.length > 0 || memory.recentProjectRefs.length > 0)) {
      lines.push(`<structured_memory>\n${JSON.stringify({
        stable_preferences: memory.stablePreferences,
        recent_project_refs: memory.recentProjectRefs,
        updated_at: memory.updatedAt,
      })}\n</structured_memory>`);
    }
    const recentContext = conversation?.summary
      || (session?.summary && session.summary !== conversation?.summary ? session.summary : "");
    if (recentContext) lines.push(`<recent_context>\n${recentContext}\n</recent_context>`);
    return lines.join("\n\n").slice(0, 12_000);
  }

  async updateConversationSummary(userId: string, imThreadId: string, sessionId?: string): Promise<void> {
    // 摘要只从最近可见消息重建，不能把旧 summary 再嵌套进去导致无限膨胀。
    const allUserMessages = this.state.messages
      .filter((message) => message.userId === userId && message.role === "user")
      .slice(-50)
      .map((message) => message.text);
    const recent = this.state.messages
      .filter((message) => message.userId === userId && message.imThreadId === imThreadId)
      .slice(-6);
    const context = recent.length > 0
      ? recent
        .map((message) => `${message.role === "user" ? "用户" : "Agent"}: ${message.text.slice(0, 1_000)}`)
        .join("\n")
      : "";
    const conversation = await this.ensureConversation(userId, imThreadId);
    conversation.summary = context.slice(0, 6_000);
    const memory = buildCreatorMemory(userId, allUserMessages, nowIso(), this.getCreatorMemory(userId));
    const existingMemoryIndex = this.state.creatorMemories.findIndex((item) => item.userId === userId);
    if (existingMemoryIndex >= 0) this.state.creatorMemories[existingMemoryIndex] = memory;
    else this.state.creatorMemories.push(memory);
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
    const archivedUserMessages = archive.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text);
    if (archivedUserMessages.length > 0) {
      const memory = buildCreatorMemory(
        archive.conversation.userId,
        archivedUserMessages,
        nowIso(),
        this.getCreatorMemory(archive.conversation.userId),
      );
      const memoryIndex = this.state.creatorMemories.findIndex((item) => item.userId === memory.userId);
      if (memoryIndex >= 0) this.state.creatorMemories[memoryIndex] = memory;
      else this.state.creatorMemories.push(memory);
    }
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
