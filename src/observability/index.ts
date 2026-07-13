import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { Logger } from "pino";
import type { LangfuseConfig } from "../config.js";
import { sanitizeTraceValue } from "./sanitize.js";

export interface Observability {
  enabled: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const DISABLED: Observability = {
  enabled: false,
  forceFlush: async () => {},
  shutdown: async () => {},
};

let active: Observability | undefined;

export function initObservability(config: LangfuseConfig, logger?: Logger): Observability {
  if (active) return active;
  if (!config.enabled) {
    active = DISABLED;
    return active;
  }
  if (!config.publicKey || !config.secretKey) {
    logger?.warn("Langfuse disabled: missing public or secret key");
    active = DISABLED;
    return active;
  }

  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    environment: config.environment,
    ...(config.release ? { release: config.release } : {}),
    exportMode: "batched",
    mask: ({ data }) => sanitizeTraceValue(data),
  });
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();

  active = {
    enabled: true,
    forceFlush: () => processor.forceFlush(),
    shutdown: async () => {
      await processor.forceFlush().catch(() => undefined);
      await sdk.shutdown();
    },
  };
  return active;
}

export function disabledObservability(): Observability {
  return DISABLED;
}
