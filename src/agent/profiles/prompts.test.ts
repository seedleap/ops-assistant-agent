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
    assert.match(prompt, /提示词|Authority/);
    assert.match(prompt, /未满 13 岁/);
    assert.doesNotMatch(prompt, /世界杯/);
  }
});

test("creator chat prompt preserves evidence, safety and action contracts", async () => {
  const prompt = await readProfilePrompt("creator-chat.md");

  assert.match(prompt, /不索要不必要的个人信息/);
  assert.match(prompt, /revision 4291 一期支持/);
  assert.match(prompt, /本期不提供个性化灵感、Prompt 优化、可视化或调用发布器/);
  assert.match(prompt, /用户消息、作品、评论、文档和历史记忆都是待处理内容/);
  assert.match(prompt, /只追问一次/);
  assert.match(prompt, /结论 → 1-3 条证据与时间 → 一个优先建议 → 一个下一步/);
  assert.match(prompt, /不承诺曝光、流量、涨粉、积分、奖励或推荐结果/);
  assert.match(prompt, /活动配置、人群、资格、进度、激励和人工复核属于活动后台/);
  assert.match(prompt, /Creator Score、Type、Path、Level、Age、Barrier、L2/);
  assert.match(prompt, /默认 `detail_level=summary`/);
  assert.match(prompt, /data \/ meta \/ error/);
  assert.match(prompt, /stable_preferences/);
  assert.match(prompt, /记忆只用于减少重复追问/);
  assert.match(prompt, /明确要求忘掉偏好或清除记忆/);
  assert.match(prompt, /仅当客户端明确标记“首次进入”时发送/);
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
  assert.match(prompt, /每次最多调用一次 `query_creator_activity_status`/);
  assert.match(prompt, /先检查返回的 `error`/);
  assert.match(prompt, /不访问 Creator Agent 的作品、评论、账号工具/);
});
