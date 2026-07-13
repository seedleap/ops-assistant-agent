import pino, { type Logger } from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: Pick<AppConfig, "logLevel" | "nodeEnv">): Logger {
  return pino({
    level: config.logLevel,
    base: {
      service: "ops-assistant-agent",
      environment: config.nodeEnv,
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "*.token",
        "*.secret",
        "*.jwtSecret",
        "*.password",
      ],
      censor: "[REDACTED]",
    },
  });
}
