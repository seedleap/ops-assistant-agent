import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";
import pino from "pino";
import request from "supertest";
import type { IdeaWorkflowRecord } from "../src/domain/types.js";

Object.assign(process.env, parse(await readFile(resolve(".env"), "utf8")));
const envFile = process.env.REAL_CASE_ENV_FILE;
if (envFile && resolve(envFile) !== resolve(".env")) {
  Object.assign(process.env, parse(await readFile(resolve(envFile), "utf8")));
}

const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
process.env.NODE_ENV = "development";
process.env.ASSISTANT_DRY_RUN = "false";
process.env.LANGFUSE_ENABLED = "true";
process.env.LANGFUSE_TRACING_ENVIRONMENT ||= "idea-real-validation";
process.env.DATA_DIR ||= resolve("data", `real-cases-${runStamp}`);
process.env.SCHEDULER_ENABLED = "false";
process.env.API_AUTH_MODE = "none";

let runtimeCredentialsPath: string | undefined;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_CLOUD_SA_JSON) {
  const credentialsPath = resolve(process.env.DATA_DIR, "runtime", "gcp-sa.json");
  // 支持容器下发的原始 JSON，也兼容 dotenv 中被转义过的多行 JSON。
  const rawCredentials = process.env.GOOGLE_CLOUD_SA_JSON;
  const credentials = rawCredentials.startsWith("{\\\"")
    ? rawCredentials.replace(/\\\"/g, "\"").replace(/\\\r?\n/g, "\\n")
    : rawCredentials;
  JSON.parse(credentials);
  await mkdir(resolve(process.env.DATA_DIR, "runtime"), { recursive: true });
  await writeFile(credentialsPath, credentials, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  runtimeCredentialsPath = credentialsPath;
}

const required = [
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "IDEA_IMAGE_BASE_URL",
  "IDEA_IMAGE_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Real-case environment is missing: ${missing.join(", ")}`);

const [{ loadConfig }, { OpsAssistant }, { JsonStore }, { IdeaWorkflow }, { AzureIdeaImageGenerator },
  { LocalIdeaAssetStore }, { initObservability }, { OutreachScheduler }, { createApp }] = await Promise.all([
  import("../src/config.js"),
  import("../src/agent/assistant.js"),
  import("../src/infrastructure/persistence/json-store.js"),
  import("../src/ideas/workflow.js"),
  import("../src/integrations/images/idea-image.js"),
  import("../src/integrations/images/idea-asset-store.js"),
  import("../src/observability/index.js"),
  import("../src/infrastructure/scheduler/outreach-scheduler.js"),
  import("../src/http/app.js"),
]);

const config = loadConfig();
const store = await JsonStore.open(config.dataDir);
const observability = initObservability(config.langfuse);
const assistant = new OpsAssistant(config, observability);
const workflow = new IdeaWorkflow(
  config,
  store,
  assistant,
  new AzureIdeaImageGenerator(config),
  new LocalIdeaAssetStore(config),
  observability,
);
const logger = pino({ enabled: false });
const scheduler = new OutreachScheduler(config, store, assistant, logger);
const app = createApp({ config, store, assistant, scheduler, logger, ideaWorkflow: workflow });

const cases = [
  {
    name: "one-thumb-garden",
    input: {
      userId: "real-case-user",
      projectId: "real-garden",
      theme: "会移动的微型花园，植物会争夺阳光",
      audience: "喜欢轻松治愈但愿意快速判断的休闲玩家",
      emotion: "治愈、紧张一瞬、立即获得满足",
      duration: "单局 30 秒",
      notes: "必须单手操作，前 3 秒能看懂",
      count: 2,
    },
  },
  {
    name: "rhythm-kitchen",
    input: {
      userId: "real-case-user",
      projectId: "real-kitchen",
      theme: "深夜厨房里食材跟着节奏逃跑",
      audience: "喜欢节奏感和搞笑反馈的短视频用户",
      emotion: "手忙脚乱但失败也好笑",
      duration: "单局 45 秒",
      notes: "不能依赖文字说明，核心反馈要视觉化",
      count: 2,
    },
  },
  {
    name: "cozy-detective",
    input: {
      userId: "real-case-user",
      projectId: "real-detective",
      theme: "在一间不断变化的房间里找出不合理物件",
      audience: "喜欢找茬和轻推理的非核心玩家",
      emotion: "好奇、发现真相的爽感",
      duration: "单局 60 秒",
      notes: "每轮必须有明确可预判变化，失败后立刻重试",
      count: 2,
    },
  },
  {
    name: "tiny-space-rescue",
    input: {
      userId: "real-case-user",
      projectId: "real-space",
      theme: "迷你太空站发生连锁故障，玩家只能选择一个舱门",
      audience: "喜欢短决策和反转结果的年轻玩家",
      emotion: "压力、预测正确后的聪明感",
      duration: "单局 30 秒",
      notes: "禁止复杂资源系统和多层菜单",
      count: 2,
    },
  },
] as const;

const results: Array<Record<string, unknown>> = [];
const caseLimit = Math.max(1, Math.min(cases.length, Number(process.env.REAL_CASE_LIMIT) || cases.length));
const requestedCase = process.env.REAL_CASE_NAME?.trim();
const selectedCases = requestedCase
  ? cases.filter((item) => item.name === requestedCase)
  : cases.slice(0, caseLimit);
if (requestedCase && selectedCases.length === 0) {
  throw new Error(`Unknown REAL_CASE_NAME: ${requestedCase}`);
}
try {
  for (const item of selectedCases) {
    const startedAt = Date.now();
    process.stdout.write(`CASE_START ${item.name}\n`);
    try {
      const submitted = await request(app)
        .post("/ideas/generate")
        .set("Idempotency-Key", `real:${runStamp}:${item.name}:${randomUUID().slice(0, 8)}`)
        .send(item.input);
      if (submitted.status !== 202) throw new Error(`Idea route returned ${submitted.status}: ${JSON.stringify(submitted.body)}`);
      const workflowId = String(submitted.body.workflow?.id || "");
      if (!workflowId) throw new Error("Idea route returned no workflow id");
      let record: Omit<IdeaWorkflowRecord, "idempotencyKey" | "inputHash" | "checkpoints" | "cancelRequested" | "metadata" | "attempt"> | undefined;
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const polled = await request(app).get(`/ideas/${workflowId}`).query({ userId: item.input.userId });
        if (polled.status === 429) {
          const retryAfterSeconds = Number(polled.headers["retry-after"]) || 1;
          await new Promise((resolvePoll) => setTimeout(resolvePoll, retryAfterSeconds * 1_000));
          continue;
        }
        if (polled.status !== 200) throw new Error(`Idea status route returned ${polled.status}`);
        record = polled.body.workflow;
        if (["completed", "completed_with_errors", "failed", "canceled"].includes(record!.status)) break;
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 1_000));
      }
      if (!record) throw new Error("Idea route polling timed out");
      const internalRecord = store.getIdeaWorkflow(workflowId)!;
      const titles = record.ideas.map((idea) => idea.title);
      const signatures = record.ideas.map((idea) => `${idea.mechanic}\0${idea.decision}`.toLowerCase());
      const imageChecks = await Promise.all(record.ideas.map(async (idea) => {
        if (idea.image.status !== "completed" || !idea.image.url?.startsWith("/ideas/assets/")) {
          return { ideaId: idea.id, ok: false, error: idea.image.error || `image status=${idea.image.status}` };
        }
        const file = resolve(config.dataDir, "idea-images", idea.image.url.split("/").at(-1)!);
        const fileStat = await stat(file);
        return { ideaId: idea.id, ok: fileStat.size > 1_000, bytes: fileStat.size, file };
      }));
      const checks = {
        terminalCompleted: record.status === "completed",
        exactCount: record.ideas.length === item.input.count,
        uniqueIds: new Set(record.ideas.map((idea) => idea.id)).size === record.ideas.length,
        uniqueMechanics: new Set(signatures).size === signatures.length,
        gateConsistency: record.ideas.every((idea) => idea.gatePassed === (idea.fatalReasons.length === 0)),
        hasUsableIdea: record.ideas.some((idea) => idea.gatePassed),
        allImagesValid: imageChecks.every((image) => image.ok),
        publicContract: !Object.keys(record).some((key) => [
          "idempotencyKey", "inputHash", "checkpoints", "cancelRequested", "metadata", "attempt",
        ].includes(key)),
        allCheckpointsSaved: Boolean(
          internalRecord.checkpoints.invention && internalRecord.checkpoints.audits && internalRecord.checkpoints.convergence,
        ),
      };
      const passed = Object.values(checks).every(Boolean);
      results.push({
        case: item.name,
        workflowId,
        status: record.status,
        durationMs: Date.now() - startedAt,
        passed,
        checks,
        rejectedCount: record.ideas.filter((idea) => !idea.gatePassed).length,
        titles,
        ideas: record.ideas,
        images: imageChecks,
        error: record.error,
      });
      process.stdout.write(`CASE_DONE ${item.name} passed=${passed} status=${record.status} titles=${JSON.stringify(titles)}\n`);
    } catch (error) {
      results.push({
        case: item.name,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      process.stdout.write(`CASE_FAILED ${item.name} error=${error instanceof Error ? error.message : String(error)}\n`);
    }
    await observability.forceFlush();
  }
} finally {
  await workflow.close().catch(() => undefined);
  await assistant.close().catch(() => undefined);
  await observability.shutdown().catch(() => undefined);
  if (runtimeCredentialsPath) await rm(runtimeCredentialsPath, { force: true });
}

const report = {
  runAt: new Date().toISOString(),
  dataDir: config.dataDir,
  modelIds: config.agentProfileOverrides["idea-inventor"]?.model,
  imageModel: config.ideaImage.model,
  langfuseEnabled: config.langfuse.enabled,
  passed: results.every((result) => result.passed === true),
  results,
};
const reportFile = resolve(config.dataDir, "real-case-report.json");
await writeFile(reportFile, JSON.stringify(report, null, 2));
process.stdout.write(`REPORT ${reportFile} passed=${report.passed}\n`);
if (!report.passed) process.exitCode = 1;
