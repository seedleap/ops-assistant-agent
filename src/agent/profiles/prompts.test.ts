import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AGENT_PROFILE_DEFINITIONS } from "./registry.js";

async function readProfilePrompt(fileName: string): Promise<string> {
  return readFile(join(process.cwd(), "config", "agent-profiles", fileName), "utf8");
}

test("every Agent Profile points to a non-empty scenario prompt", async () => {
  for (const profile of AGENT_PROFILE_DEFINITIONS) {
    const prompt = await readProfilePrompt(profile.promptFileName);
    assert.ok(prompt.trim().length > 500, `${profile.id} prompt is unexpectedly short`);
    assert.match(prompt, /Instruction boundary/);
    assert.match(prompt, /未满 13 岁/);
    assert.doesNotMatch(prompt, /世界杯/);
  }
});

test("creator chat prompt preserves evidence, safety and action contracts", async () => {
  const prompt = await readProfilePrompt("creator-chat.md");

  assert.match(prompt, /不索要真实姓名、联系方式、学校、住址/);
  assert.match(prompt, /不得编造数据、活动、奖励、Level、曝光机会、活动资格或官方承诺/);
  assert.match(prompt, /每次最多追问一个最关键的问题/);
  assert.match(prompt, /一句话结论/);
  assert.match(prompt, /一到三条关键证据，并带上时间范围/);
  assert.match(prompt, /一个优先级最高、可以直接执行的修改建议/);
  assert.match(prompt, /不得暗示参加后一定获得曝光、奖励、升级或官方推荐/);
});

test("creator outreach prompt preserves value gate and no-send contract", async () => {
  const prompt = await readProfilePrompt("creator-outreach.md");

  assert.match(prompt, /减少无价值打扰/);
  assert.match(prompt, /内容与最近一次触达重复/);
  assert.match(prompt, /当前仍处于静默窗口/);
  assert.match(prompt, /不得编造数据变化、活动、奖励、资格、Level、曝光机会或官方承诺/);
  assert.match(prompt, /中文通常不超过 80 个字/);
  assert.match(prompt, /NO_OUTREACH: <一句话内部原因>/);
  assert.match(prompt, /不对曝光、奖励、资格、升级或结果作保证/);
});
