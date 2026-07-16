import { networkInterfaces } from "node:os";
import { OpsAssistant } from "./agent/assistant.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { initObservability } from "./observability/index.js";
import { OutreachScheduler } from "./infrastructure/scheduler/outreach-scheduler.js";
import { createApp } from "./http/app.js";
import { JsonStore } from "./infrastructure/persistence/json-store.js";
import { AzureIdeaImageGenerator } from "./integrations/images/idea-image.js";
import { IdeaWorkflow } from "./ideas/workflow.js";
import { createIdeaAssetStore } from "./integrations/images/idea-asset-store.js";

/* 启动文件只做依赖组装；具体业务由各模块负责，便于测试时替换依赖。 */
const config = loadConfig();
const logger = createLogger(config);
const store = await JsonStore.open(config.dataDir);
const observability = initObservability(config.langfuse, logger);
const assistant = new OpsAssistant(config, observability);
const scheduler = new OutreachScheduler(config, store, assistant, logger);
const ideaWorkflow = new IdeaWorkflow(
  config,
  store,
  assistant,
  new AzureIdeaImageGenerator(config),
  createIdeaAssetStore(config),
  observability,
);
const app = createApp({ config, store, assistant, scheduler, logger, ideaWorkflow });

// JSON Store 是当前单进程持久化边界；重启时从最近 checkpoint 恢复未完成的 Idea 任务。
ideaWorkflow.resumePending();

if (config.schedulerEnabled) scheduler.start();

const httpServer = app.listen(config.port, config.host, () => {
  const lanIps = Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  logger.info({ host: config.host, port: config.port, lanIps }, "server listening");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  scheduler.stop();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
  await ideaWorkflow.close().catch((error) => {
    logger.error({ err: error }, "idea workflow shutdown wait failed");
  });
  await assistant.close().catch((error) => {
    logger.error({ err: error }, "MCP client shutdown failed");
  });
  await observability.shutdown().catch((error) => {
    logger.error({ err: error }, "observability shutdown failed");
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
