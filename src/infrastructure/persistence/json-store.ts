import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Mutex } from "async-mutex";
import type {
  AssistantRunRecord,
  ConversationRecord,
  ISODateString,
  MessageRecord,
  OutboxMessage,
  ScheduleRecord,
  StoreState,
} from "../../domain/types.js";

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
    return new JsonStore(filePath, JSON.parse(raw) as StoreState);
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
