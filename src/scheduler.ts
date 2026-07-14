import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { createId, JsonStore } from "./store.js";
import type { ConversationRecord, OutboxMessage, ScheduleRecord } from "./types.js";
import { OpsAssistant } from "./agent/assistant.js";
import type { Logger } from "pino";

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function minutesSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 60_000;
}

function buildOutreachPrompt(schedule: ScheduleRecord, conversation: ConversationRecord | undefined): string {
  const summary = conversation?.summary ? `\nKnown conversation summary:\n${conversation.summary}` : "";
  return `Run a proactive outreach check for this IM user.

Schedule name: ${schedule.name}
Schedule instruction:
${schedule.prompt}

The user has been silent for at least ${schedule.silentMinutes} minutes.
Generate one concise IM message if outreach is useful.
If outreach is not useful, answer "NO_OUTREACH: <reason>".${summary}`;
}

export interface SchedulerTickResult {
  scheduleId: string;
  action: "not_due" | "deferred_until_silent" | "created_outbox" | "skipped_no_outreach" | "failed";
  outbox?: OutboxMessage;
  nextRunAt?: string;
  reason?: string;
}

export class OutreachScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly assistant: OpsAssistant,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error({ err: error }, "scheduler tick failed");
      });
    }, this.config.schedulerPollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()): Promise<SchedulerTickResult[]> {
    const results: SchedulerTickResult[] = [];
    for (const schedule of this.store.listSchedules()) {
      results.push(await this.processSchedule(schedule, now));
    }
    return results;
  }

  private async processSchedule(schedule: ScheduleRecord, now: Date): Promise<SchedulerTickResult> {
    if (!schedule.enabled || new Date(schedule.nextRunAt).getTime() > now.getTime()) {
      return { scheduleId: schedule.id, action: "not_due", nextRunAt: schedule.nextRunAt };
    }
    if (this.running.has(schedule.id)) {
      return { scheduleId: schedule.id, action: "not_due", reason: "already running" };
    }

    const conversation = this.store.getConversation(schedule.userId, schedule.imThreadId);
    const silenceStart = conversation?.lastUserMessageAt || schedule.createdAt;
    const silentFor = minutesSince(silenceStart, now);
    if (silentFor < schedule.silentMinutes) {
      const nextRunAt = addMinutes(new Date(silenceStart), schedule.silentMinutes);
      await this.store.updateScheduleTiming(schedule.id, { nextRunAt });
      return {
        scheduleId: schedule.id,
        action: "deferred_until_silent",
        nextRunAt: nextRunAt.toISOString(),
        reason: `user silent for ${silentFor.toFixed(1)}m, needs ${schedule.silentMinutes}m`,
      };
    }

    this.running.add(schedule.id);
    const runId = createId("run");
    const sessionDir = join(this.config.dataDir, "pi-sessions", "outreach", runId);
    const workDir = join(this.config.dataDir, "workspaces", schedule.userId, schedule.imThreadId, "outreach", runId);
    const prompt = buildOutreachPrompt(schedule, conversation);

    await this.store.beginRun({
      id: runId,
      type: "outreach",
      userId: schedule.userId,
      imThreadId: schedule.imThreadId,
      scheduleId: schedule.id,
      sessionDir,
      input: prompt,
    });

    try {
      const output = await this.assistant.run({
        type: "outreach",
        userId: schedule.userId,
        imThreadId: schedule.imThreadId,
        runId,
        prompt,
        workDir,
        sessionDir,
        continueSession: false,
      });
      const nextRunAt = addMinutes(now, schedule.intervalMinutes);
      await this.store.updateScheduleTiming(schedule.id, { lastRunAt: now, nextRunAt });

      if (/^NO_OUTREACH:/i.test(output.trim())) {
        await this.store.finishRun(runId, {
          status: "skipped",
          output,
          reason: output.trim(),
          completedAt: now,
        });
        return { scheduleId: schedule.id, action: "skipped_no_outreach", nextRunAt: nextRunAt.toISOString(), reason: output };
      }

      const outbox = await this.store.createOutbox({
        userId: schedule.userId,
        imThreadId: schedule.imThreadId,
        scheduleId: schedule.id,
        runId,
        text: output,
        createdAt: now,
      });
      await this.store.finishRun(runId, {
        status: "completed",
        output,
        completedAt: now,
      });
      return { scheduleId: schedule.id, action: "created_outbox", outbox, nextRunAt: nextRunAt.toISOString() };
    } catch (err) {
      const nextRunAt = addMinutes(now, Math.min(schedule.intervalMinutes, 10));
      await this.store.updateScheduleTiming(schedule.id, { nextRunAt });
      await this.store.finishRun(runId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: now,
      });
      return {
        scheduleId: schedule.id,
        action: "failed",
        nextRunAt: nextRunAt.toISOString(),
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.running.delete(schedule.id);
    }
  }
}
