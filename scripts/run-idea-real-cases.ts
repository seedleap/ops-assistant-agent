import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";

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
  JSON.parse(process.env.GOOGLE_CLOUD_SA_JSON);
  await mkdir(resolve(process.env.DATA_DIR, "runtime"), { recursive: true });
  await writeFile(credentialsPath, process.env.GOOGLE_CLOUD_SA_JSON, { mode: 0o600 });
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
  { LocalIdeaAssetStore }, { initObservability }] = await Promise.all([
  import("../src/config.js"),
  import("../src/agent/assistant.js"),
  import("../src/infrastructure/persistence/json-store.js"),
  import("../src/ideas/workflow.js"),
  import("../src/integrations/images/idea-image.js"),
  import("../src/integrations/images/idea-asset-store.js"),
  import("../src/observability/index.js"),
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
try {
  for (const item of cases.slice(0, caseLimit)) {
    const startedAt = Date.now();
    process.stdout.write(`CASE_START ${item.name}\n`);
    try {
      const record = await workflow.run(item.input, `real:${runStamp}:${item.name}:${randomUUID().slice(0, 8)}`);
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
        allGatesPassed: record.ideas.every((idea) => idea.gatePassed && idea.fatalReasons.length === 0),
        allImagesValid: imageChecks.every((image) => image.ok),
        allCheckpointsSaved: Boolean(
          record.checkpoints.invention && record.checkpoints.audits && record.checkpoints.convergence,
        ),
      };
      const passed = Object.values(checks).every(Boolean);
      results.push({
        case: item.name,
        workflowId: record.id,
        status: record.status,
        durationMs: Date.now() - startedAt,
        passed,
        checks,
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
