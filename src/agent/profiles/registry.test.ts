import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../../config.js";
import { CREATOR_SUPPORT_TOOL_NAMES, DATA_PRIMITIVE_TOOL_NAMES } from "../../integrations/loopit/tool-catalog.js";
import { AGENT_PROFILES, AGENT_PROFILE_IDS, isAgentProfileId } from "./catalog.js";
import { resolveAgentProfile, resolveAgentProfileById } from "./registry.js";

test("catalog keys are the Profile ID source of truth", () => {
  assert.deepEqual(AGENT_PROFILE_IDS, ["creator-chat", "creator-outreach"]);
  assert.equal(isAgentProfileId("creator-chat"), true);
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
  assert.equal(chat.prompt.file, resolve("/tmp/ops-agent-prompts/creator-chat.md"));
  assert.equal(chat.prompt.version, "creator-support-v4");
  assert.equal(chat.runtime.maxTurns, 12);
  assert.equal(chat.runtime.maxRetries, 2);
  assert.equal(chat.runtime.compactionEnabled, true);
  assert.ok(chat.toolNames.includes("creator_work_analyze"));
  assert.ok(chat.toolNames.includes("creator_activity_status"));
  assert.ok(!chat.toolNames.some((name) => name.startsWith("query_")));
  assert.deepEqual(chat.toolNames.filter((name) => name !== "read"), CREATOR_SUPPORT_TOOL_NAMES);
  assert.equal(chat.toolNames.some((name) => DATA_PRIMITIVE_TOOL_NAMES.includes(name as never)), false);
  assert.deepEqual(chat.localSkills, ["creator-analysis", "creator-inspiration", "creator-guide", "ops-activities"]);

  const outreach = resolveAgentProfileById(config, "creator-outreach");
  assert.equal(outreach.prompt.file, resolve("/tmp/ops-agent-prompts/creator-outreach.md"));
  assert.equal(outreach.prompt.version, "creator-outreach-v4");
  assert.equal(outreach.runtime.timeoutMs, 45_000);
  assert.equal(outreach.runtime.compactionEnabled, false);
  assert.ok(!outreach.toolNames.includes("creator_public_work_inspect"));
  assert.ok(outreach.toolNames.includes("creator_activity_status"));
  assert.deepEqual(
    outreach.toolNames.filter((name) => name !== "read"),
    CREATOR_SUPPORT_TOOL_NAMES.filter((name) => name !== "creator_public_work_inspect"),
  );
  assert.deepEqual(outreach.localSkills, ["creator-analysis", "creator-inspiration", "creator-guide", "ops-activities"]);
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
});

test("one Profile model override does not implicitly change another Profile", () => {
  const config = loadConfig({
    ASSISTANT_DRY_RUN: "true",
    ASSISTANT_MODEL_PROVIDER: "openai",
    ASSISTANT_MODEL_ID: "gpt-test",
    MODEL_WHITELIST: "openai/gpt-test,google-vertex/gemini-3-flash-preview",
  });

  const chat = resolveAgentProfileById(config, "creator-chat");
  const outreach = resolveAgentProfileById(config, "creator-outreach");
  assert.equal(chat.model.provider, "openai");
  assert.equal(outreach.model.provider, "google-vertex");
  assert.equal(outreach.model.modelId, "gemini-3-flash-preview");
});
