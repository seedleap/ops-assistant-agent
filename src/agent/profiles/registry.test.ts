import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../config.js";
import { resolveAgentProfile, resolveAgentProfileById } from "./registry.js";

test("each Agent Profile owns its prompt, tools and runtime policy", () => {
  const config = loadConfig({
    ASSISTANT_DRY_RUN: "true",
    AGENT_PROMPTS_DIR: "/tmp/ops-agent-prompts",
    ASSISTANT_MAX_TURNS: "12",
    OUTREACH_TIMEOUT_MS: "45000",
  });

  const chat = resolveAgentProfileById(config, "creator-chat");
  assert.equal(chat.systemPromptFile, "/tmp/ops-agent-prompts/creator-chat.md");
  assert.equal(chat.promptVersion, "creator-growth-v1");
  assert.equal(chat.maxTurns, 12);
  assert.equal(chat.maxRetries, 2);
  assert.equal(chat.compactionEnabled, true);
  assert.ok(chat.toolNames.includes("query_work_prompt"));

  const outreach = resolveAgentProfileById(config, "creator-outreach");
  assert.equal(outreach.systemPromptFile, "/tmp/ops-agent-prompts/creator-outreach.md");
  assert.equal(outreach.promptVersion, "creator-outreach-v1");
  assert.equal(outreach.timeoutMs, 45_000);
  assert.equal(outreach.compactionEnabled, false);
  assert.ok(!outreach.toolNames.includes("query_work_prompt"));
});

test("run input selects the Profile and only chat accepts an allowed model override", () => {
  const config = loadConfig({ ASSISTANT_DRY_RUN: "true" });
  const base = {
    userId: "u1",
    imThreadId: "t1",
    runId: "r1",
    prompt: "test",
    workDir: "/tmp/work",
    sessionDir: "/tmp/session",
    continueSession: false,
  } as const;

  const chat = resolveAgentProfile(config, {
    ...base,
    type: "interactive",
    model: "gemini-3.1-flash-lite",
  });
  assert.equal(chat.id, "creator-chat");
  assert.equal(chat.modelId, "gemini-3.1-flash-lite");

  const outreach = resolveAgentProfile(config, { ...base, type: "outreach" });
  assert.equal(outreach.id, "creator-outreach");
  assert.equal(outreach.modelId, config.agentProfiles.creatorOutreach.modelId);
});

test("one Profile model override does not implicitly change another Profile", () => {
  const config = loadConfig({
    ASSISTANT_DRY_RUN: "true",
    ASSISTANT_MODEL_PROVIDER: "openai",
    ASSISTANT_MODEL_ID: "gpt-test",
    MODEL_WHITELIST: "openai/gpt-test,google-vertex/gemini-3-flash-preview",
  });

  assert.equal(config.agentProfiles.creatorChat.provider, "openai");
  assert.equal(config.agentProfiles.creatorOutreach.provider, "google-vertex");
  assert.equal(config.agentProfiles.creatorOutreach.modelId, "gemini-3-flash-preview");
});
