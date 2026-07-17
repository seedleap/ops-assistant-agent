import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../config.js";
import { AGENT_PROFILES, AGENT_PROFILE_IDS, isAgentProfileId } from "./catalog.js";
import { resolveAgentProfile, resolveAgentProfileById } from "./registry.js";

test("catalog keys are the Profile ID source of truth", () => {
  assert.deepEqual(AGENT_PROFILE_IDS, [
    "creator-chat",
    "creator-outreach",
    "idea-inventor",
    "idea-auditor",
    "idea-converger",
  ]);
  assert.equal(isAgentProfileId("creator-chat"), true);
  assert.equal(isAgentProfileId("idea-inventor"), true);
  assert.equal(isAgentProfileId("unknown"), false);
});

test("Profile defaults resolve without deploy-time overrides", () => {
  const config = loadConfig({ ASSISTANT_DRY_RUN: "true" });
  config.agentProfileOverrides = {};

  const chat = resolveAgentProfileById(config, "creator-chat");
  assert.deepEqual(chat.model, AGENT_PROFILES["creator-chat"].model);
  assert.deepEqual(chat.runtime, AGENT_PROFILES["creator-chat"].runtime);
});

test("each Agent Profile owns its prompt, tools and runtime policy", () => {
  const config = loadConfig({
    ASSISTANT_DRY_RUN: "true",
    AGENT_PROMPTS_DIR: "/tmp/ops-agent-prompts",
    ASSISTANT_MAX_TURNS: "12",
    OUTREACH_TIMEOUT_MS: "45000",
  });

  const chat = resolveAgentProfileById(config, "creator-chat");
  assert.equal(chat.prompt.file, "/tmp/ops-agent-prompts/creator-chat.md");
  assert.equal(chat.prompt.version, "creator-growth-v2");
  assert.equal(chat.runtime.maxTurns, 12);
  assert.equal(chat.runtime.maxRetries, 2);
  assert.equal(chat.runtime.compactionEnabled, true);
  assert.ok(chat.toolNames.includes("query_work_prompt"));
  assert.deepEqual(chat.localSkills, ["creator-guide", "ops-activities"]);

  const outreach = resolveAgentProfileById(config, "creator-outreach");
  assert.equal(outreach.prompt.file, "/tmp/ops-agent-prompts/creator-outreach.md");
  assert.equal(outreach.prompt.version, "creator-outreach-v2");
  assert.equal(outreach.runtime.timeoutMs, 45_000);
  assert.equal(outreach.runtime.compactionEnabled, false);
  assert.ok(!outreach.toolNames.includes("query_work_prompt"));
  assert.deepEqual(outreach.localSkills, ["creator-guide", "ops-activities"]);

  const inventor = resolveAgentProfileById(config, "idea-inventor");
  assert.equal(inventor.prompt.version, "idea-workflow-v2");
  assert.equal(inventor.traceName, "idea");
  assert.equal(inventor.model.modelId, "gemini-3.1-pro-preview");
  assert.deepEqual(inventor.toolNames, []);
  assert.equal(inventor.runtime.maxTurns, 2);
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
  assert.equal(chat.model.modelId, "gemini-3.1-flash-lite");

  const outreach = resolveAgentProfile(config, { ...base, type: "outreach" });
  assert.equal(outreach.id, "creator-outreach");
  assert.equal(outreach.model.modelId, AGENT_PROFILES["creator-outreach"].model.modelId);

  const inventor = resolveAgentProfile(config, {
    ...base,
    type: "interactive",
    profileId: "idea-inventor",
  });
  assert.equal(inventor.id, "idea-inventor");
  assert.throws(
    () => resolveAgentProfile(config, { ...base, type: "interactive", profileId: "unknown" }),
    /Unknown Agent Profile/,
  );
});

test("one Profile model override does not implicitly change another Profile", () => {
  const config = loadConfig({
    ASSISTANT_DRY_RUN: "true",
    ASSISTANT_MODEL_PROVIDER: "openai",
    ASSISTANT_MODEL_ID: "gpt-test",
    MODEL_WHITELIST: "openai/gpt-test,google-vertex/gemini-3-flash-preview,google-vertex/gemini-3.1-pro-preview",
  });

  const chat = resolveAgentProfileById(config, "creator-chat");
  const outreach = resolveAgentProfileById(config, "creator-outreach");
  assert.equal(chat.model.provider, "openai");
  assert.equal(outreach.model.provider, "google-vertex");
  assert.equal(outreach.model.modelId, "gemini-3-flash-preview");
});
