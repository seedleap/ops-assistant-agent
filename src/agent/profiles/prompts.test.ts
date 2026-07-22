import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AGENT_PROFILES } from "./catalog.js";

async function readProfilePrompt(fileName: string): Promise<string> {
  return readFile(join(process.cwd(), "config", "agent-profiles", fileName), "utf8");
}

test("every Agent Profile points to a non-empty scenario prompt", async () => {
  for (const [id, profile] of Object.entries(AGENT_PROFILES)) {
    const prompt = await readProfilePrompt(profile.prompt.fileName);
    assert.ok(prompt.trim().length > 500, `${id} prompt is unexpectedly short`);
    assert.match(prompt, /Instruction boundary/);
    assert.match(prompt, /未满 13 岁/);
    assert.doesNotMatch(prompt, /世界杯/);
  }
});

test("creator chat prompt preserves evidence, safety and action contracts", async () => {
  const prompt = await readProfilePrompt("creator-chat.md");

  assert.match(prompt, /不索要真实姓名、联系方式、学校、住址/);
  assert.match(prompt, /不得编造数据、活动、奖励、资格、Level、曝光机会或官方承诺/);
  assert.match(prompt, /必要时最多追问一个关键问题/);
  assert.match(prompt, /一句结论/);
  assert.match(prompt, /1-3 条证据与时间/);
  assert.match(prompt, /一个最高优先级修改/);
  assert.match(prompt, /不承诺曝光、流量、排名、升级、积分或奖励结果/);
  assert.match(prompt, /你不是数据计算、活动、任务、积分、消息或客户端系统/);
  assert.match(prompt, /运营规则只能证明“规则是什么”/);
  assert.match(prompt, /只有资格为已确认且活动有效时/);
  assert.match(prompt, /不根据作品数据自行推算/);
  assert.match(prompt, /Creator Score、Type、Path、Level、Age、Barrier、L2/);
  assert.match(prompt, /引用数据时说明 `as_of` 或时间范围/);
});

test("creator outreach prompt preserves value gate and no-send contract", async () => {
  const prompt = await readProfilePrompt("creator-outreach.md");

  assert.match(prompt, /减少打扰/);
  assert.match(prompt, /内容与最近一次触达重复/);
  assert.match(prompt, /当前仍处于静默窗口/);
  assert.match(prompt, /只使用本轮查询的事实/);
  assert.match(prompt, /中文通常不超过 80 个字/);
  assert.match(prompt, /NO_OUTREACH: <一句话内部原因码和说明>/);
  assert.match(prompt, /不保证曝光、奖励、资格、升级或结果/);
  assert.match(prompt, /你只负责在活动运营中台完成硬规则筛选后/);
  assert.match(prompt, /运营人群标签和目录搜索结果都不等于资格/);
  assert.match(prompt, /活动有效、资格已确认、年龄路线允许、官方 action 可用/);
  assert.match(prompt, /Creator Score、Type、Path、Level、Age、Barrier、L2/);
});
