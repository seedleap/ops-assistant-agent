import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { selectSystemPrompt } from "../prompt.js";
import { AGENT_PROFILES } from "./catalog.js";

async function readProfilePrompt(fileName: string, section?: string): Promise<string> {
  const source = await readFile(join(process.cwd(), "config", "agent-profiles", fileName), "utf8");
  return selectSystemPrompt(source, section);
}

test("every Agent Profile points to a non-empty scenario prompt", async () => {
  for (const [id, profile] of Object.entries(AGENT_PROFILES)) {
    const section = "section" in profile.prompt ? profile.prompt.section : undefined;
    const prompt = await readProfilePrompt(profile.prompt.fileName, section);
    assert.ok(prompt.trim().length > 500, `${id} prompt is unexpectedly short`);
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
  assert.match(prompt, /你不是活动、任务、积分或客户端系统/);
  assert.match(prompt, /活动说明或运营知识只能证明“规则是什么”/);
  assert.match(prompt, /只有收到活动中台确认的资格状态/);
  assert.match(prompt, /只复述活动中台返回的当前状态，不根据作品数据自行推算/);
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
  assert.match(prompt, /你处于多平台创作者运营链路的表达层/);
  assert.match(prompt, /运营人群标签只代表候选范围，不等于活动资格/);
  assert.match(prompt, /必须同时具备活动中台确认的当前资格、有效活动状态和官方行动入口/);
  assert.match(prompt, /结构化活动卡片中的活动 ID、任务、奖励、进度、按钮和跳转地址/);
});

test("idea workflow prompts preserve stage separation and JSON contracts", async () => {
  const inventor = await readProfilePrompt("idea.md", "idea-inventor");
  const auditor = await readProfilePrompt("idea.md", "idea-auditor");
  const converger = await readProfilePrompt("idea.md", "idea-converger");

  assert.match(inventor, /可证伪/);
  assert.match(inventor, /3 到 5 秒/);
  assert.match(auditor, /不能修改候选/);
  assert.match(auditor, /fatalReasons/);
  assert.match(converger, /不得在收敛阶段凭空修复候选/);
  assert.match(converger, /imagePrompt/);
});
