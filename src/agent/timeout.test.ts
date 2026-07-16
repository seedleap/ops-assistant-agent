import assert from "node:assert/strict";
import test from "node:test";
import { OpsAssistant } from "./assistant.js";

test("agent timeout rejects even when abort does not settle", async () => {
  const assistant = Object.create(OpsAssistant.prototype) as OpsAssistant;
  const promptWithTimeout = (assistant as unknown as {
    promptWithTimeout(session: unknown, prompt: string, timeoutMs: number): Promise<void>;
  }).promptWithTimeout.bind(assistant);
  const session = {
    prompt: () => new Promise<void>(() => {}),
    abort: () => new Promise<void>(() => {}),
  };

  await assert.rejects(
    () => promptWithTimeout(session, "test", 10),
    /Agent timed out after 10ms/,
  );
});
