import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CREATOR_CHAT_PROFILE } from "./creator-chat.js";
import { CREATOR_OUTREACH_PROFILE } from "./creator-outreach.js";
import { CREATOR_SUPPORT_TOOL_NAMES, DATA_PRIMITIVE_TOOL_NAMES } from "../../integrations/loopit/tool-catalog.js";

interface ToolRoutingCase {
  id: string;
  runType: "interactive" | "outreach";
  prompt: string;
  expectedTools: string[];
}

test("tool-routing eval cases stay inside the business-tool boundary", async () => {
  const raw = await readFile(join(process.cwd(), "evals", "tool-routing-cases.json"), "utf8");
  const cases = JSON.parse(raw) as ToolRoutingCase[];
  assert.ok(cases.length >= 10);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);

  const businessNames = new Set<string>(CREATOR_SUPPORT_TOOL_NAMES);
  const primitiveNames = new Set<string>(DATA_PRIMITIVE_TOOL_NAMES);
  for (const item of cases) {
    assert.ok(item.prompt.trim(), `${item.id} needs a prompt`);
    const profileTools = new Set<string>(
      item.runType === "interactive"
        ? CREATOR_CHAT_PROFILE.toolNames
        : CREATOR_OUTREACH_PROFILE.toolNames,
    );
    for (const name of item.expectedTools) {
      assert.ok(businessNames.has(name), `${item.id} references unknown business tool ${name}`);
      assert.ok(profileTools.has(name), `${item.id} expects tool ${name} outside its Profile`);
      assert.equal(primitiveNames.has(name), false, `${item.id} exposes data primitive ${name}`);
    }
  }
});

test("routing cases cover every revision 4291 business tool", async () => {
  const raw = await readFile(join(process.cwd(), "evals", "tool-routing-cases.json"), "utf8");
  const cases = JSON.parse(raw) as ToolRoutingCase[];
  const covered = new Set(cases.flatMap((item) => item.expectedTools));
  assert.deepEqual(
    CREATOR_SUPPORT_TOOL_NAMES.filter((name) => !covered.has(name)),
    [],
  );
});

test("revision 4291 keeps future scenarios and activity state out of creator chat", () => {
  assert.deepEqual(CREATOR_CHAT_PROFILE.toolNames, [
    "read",
    "creator_project_analyze",
    "creator_comments_analyze",
    "creator_account_summarize",
  ]);
  assert.deepEqual(CREATOR_OUTREACH_PROFILE.toolNames, ["read", "creator_activity_status"]);
  const chatSkills = new Set<string>(CREATOR_CHAT_PROFILE.localSkills);
  assert.ok(!chatSkills.has("creator-inspiration"));
  assert.ok(!chatSkills.has("ops-activities"));
});
