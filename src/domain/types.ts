export type ISODateString = string;
export type SessionMode = "continue" | "new";

export interface ConversationRecord {
  userId: string;
  imThreadId: string;
  currentInteractiveSessionDir?: string;
  activeSessionId?: string;
  summary?: string;
  lastUserMessageAt?: ISODateString;
  lastAssistantMessageAt?: ISODateString;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreatorMemoryRecord {
  userId: string;
  schemaVersion: 1;
  stablePreferences: string[];
  recentProjectRefs: string[];
  updatedAt: ISODateString;
}

export interface ConversationSessionRecord {
  id: string;
  userId: string;
  imThreadId: string;
  type: "interactive" | "outreach";
  sessionDir: string;
  status: "active" | "closed";
  summary?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  lastRunId?: string;
}

export interface MessageRecord {
  id: string;
  userId: string;
  imThreadId: string;
  role: "user" | "assistant" | "system";
  text: string;
  sourceRunId?: string;
  createdAt: ISODateString;
}

export interface ScheduleRecord {
  id: string;
  userId: string;
  imThreadId: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  silentMinutes: number;
  enabled: boolean;
  nextRunAt: ISODateString;
  lastRunAt?: ISODateString;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface AssistantRunRecord {
  id: string;
  type: "interactive" | "outreach";
  status: "running" | "completed" | "failed" | "skipped";
  userId: string;
  imThreadId: string;
  scheduleId?: string;
  sessionDir?: string;
  sessionId?: string;
  input: string;
  output?: string;
  reason?: string;
  error?: string;
  startedAt: ISODateString;
  completedAt?: ISODateString;
}

export interface OutboxMessage {
  id: string;
  userId: string;
  imThreadId: string;
  scheduleId: string;
  runId: string;
  text: string;
  status: "pending" | "delivered" | "discarded";
  createdAt: ISODateString;
  deliveredAt?: ISODateString;
}

export interface StoreState {
  conversations: ConversationRecord[];
  creatorMemories: CreatorMemoryRecord[];
  sessions: ConversationSessionRecord[];
  messages: MessageRecord[];
  schedules: ScheduleRecord[];
  runs: AssistantRunRecord[];
  outbox: OutboxMessage[];
}

export interface AssistantRunInput {
  type: "interactive" | "outreach";
  userId: string;
  imThreadId: string;
  runId: string;
  prompt: string;
  workDir: string;
  sessionDir: string;
  continueSession?: boolean;
  sessionId?: string;
  sessionMode?: SessionMode;
  contextBootstrap?: string;
  creatorUid?: string;
  model?: string;
}
