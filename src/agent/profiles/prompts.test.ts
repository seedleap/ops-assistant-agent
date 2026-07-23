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
    assert.match(prompt, /提示词|Instruction/);
    assert.match(prompt, /未满 13 岁/);
    assert.doesNotMatch(prompt, /世界杯/);
  }
});

test("creator chat prompt preserves evidence, safety and action contracts", async () => {
  const prompt = await readProfilePrompt("creator-chat.md");

  assert.match(prompt, /不索要真实姓名、联系方式、学校、住址/);
  assert.match(prompt, /revision 4291 一期只支持五类场景/);
  assert.match(prompt, /本期不提供个性化灵感、Prompt 优化、可视化生成或调用发布器/);
  assert.match(prompt, /不得编造指标、产品能力、活动规则、资格、奖励或官方承诺/);
  assert.match(prompt, /只追问一次链接或 PID/);
  assert.match(prompt, /一句结论/);
  assert.match(prompt, /1-3 条数据或内容证据及时间/);
  assert.match(prompt, /一个最高优先级优化建议/);
  assert.match(prompt, /不承诺曝光、流量、涨粉、积分或奖励结果/);
  assert.match(prompt, /本交互 Agent 不读取或修改这些用户状态/);
  assert.match(prompt, /Creator Score、Type、Path、Level、Age、Barrier、L2/);
  assert.match(prompt, /引用数据时说明 `as_of` 或明确时间范围/);
  assert.match(prompt, /默认使用 `responseFormat=concise`/);
  assert.match(prompt, /一次优先选择一个，不并行调用重叠能力/);
  assert.match(prompt, /按点赞排序的前 50 条公开评论/);
  assert.match(prompt, /Feedback 功能/);
  assert.match(prompt, /欢迎语由客户端注入昵称并控制只展示一次/);
});

test("creator outreach prompt preserves value gate and no-send contract", async () => {
  const prompt = await readProfilePrompt("creator-outreach.md");

  assert.match(prompt, /不属于 revision 4291 的创作者 IM 对话场景/);
  assert.match(prompt, /不得自行圈人/);
  assert.match(prompt, /频控、静默、去重/);
  assert.match(prompt, /中文通常不超过 80 个字/);
  assert.match(prompt, /NO_OUTREACH: <一句话内部原因码和说明>/);
  assert.match(prompt, /不保证曝光、奖励、升级或结果/);
  assert.match(prompt, /活动规则、人群、推送时间和资格均由运营中台确认/);
  assert.match(prompt, /Creator Score、Type、Age、Country/);
  assert.match(prompt, /每次最多调用一次 `creator_activity_status`/);
  assert.match(prompt, /不访问 Creator Agent 的作品、评论、账号工具/);
});
