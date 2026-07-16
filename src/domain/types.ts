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

export interface IdeaImageResult {
  status: "pending" | "completed" | "failed";
  url?: string;
  mimeType?: string;
  model?: string;
  storage?: "local" | "s3";
  error?: string;
}

export interface GeneratedIdea {
  id: string;
  title: string;
  summary: string;
  mechanic: string;
  playerAction: string;
  decision: string;
  loop: string;
  failureRecovery: string;
  whyFun: string;
  prototypeTest: string;
  gatePassed: boolean;
  fatalReasons: string[];
  imagePrompt: string;
  image: IdeaImageResult;
}

export interface IdeaWorkflowRecord {
  id: string;
  idempotencyKey: string;
  inputHash: string;
  userId: string;
  projectId?: string;
  status: "queued" | "running" | "completed" | "completed_with_errors" | "failed" | "canceled";
  stage: "queued" | "invent" | "audit" | "converge" | "images" | "complete";
  input: Record<string, unknown>;
  ideas: GeneratedIdea[];
  checkpoints: {
    invention?: unknown;
    audits?: unknown;
    convergence?: unknown;
  };
  attempt: number;
  cancelRequested?: boolean;
  metadata: {
    workflowVersion: string;
    promptVersion: string;
    modelIds: string[];
  };
  error?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  startedAt?: ISODateString;
  completedAt?: ISODateString;
}

export interface StoreState {
  conversations: ConversationRecord[];
  sessions: ConversationSessionRecord[];
  messages: MessageRecord[];
  schedules: ScheduleRecord[];
  runs: AssistantRunRecord[];
  outbox: OutboxMessage[];
  ideaWorkflows: IdeaWorkflowRecord[];
}

export interface AssistantRunInput {
  type: "interactive" | "outreach";
  /** Internal workflow stages may select a dedicated Profile without exposing it on IM routes. */
  profileId?: string;
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
  traceContext?: {
    workflowId: string;
    stage: string;
    attempt: number;
    parentSpanContext?: {
      traceId: string;
      spanId: string;
      traceFlags: number;
      isRemote?: boolean;
    };
  };
  creatorUid?: string;
  model?: string;
}
