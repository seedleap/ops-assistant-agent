import type { IdeaWorkflowRecord } from "../domain/types.js";

/**
 * 图片生成阶段的固定业务要求。
 *
 * 业务目标是把每个创意变成一张“看得懂玩法”的游戏效果图，
 * 而不是只追求好看的海报或概念图。画面必须展示真实游玩瞬间，
 * 让用户能够直接判断目标、操作、局面变化和即时反馈是否成立。
 * 同时避免失败页、结算页、无关角色和文字按钮干扰用户选择创意。
 *
 * 这些规则对所有创意一致，集中维护可以避免图片之间标准漂移；
 * 每个创意自身的玩法信息则由 buildIdeaImagePrompt 动态补充。
 */
const IDEA_IMAGE_SYSTEM_PROMPT = `Create a polished 9:16 vertical mobile game screenshot, not a poster.
Show one active gameplay moment and communicate the mechanic visually.
Clearly distinguish actionable targets, predictive signals, current state, and immediate gameplay feedback.
Do not show a failure, reset, retry, game-over, or results screen.
Do not add weapons, characters, written text, generic buttons, or unrelated objects unless explicitly required by the core gameplay.`;

type IdeaForImage = IdeaWorkflowRecord["ideas"][number];

export function buildIdeaImagePrompt(idea: IdeaForImage): string {
  const ideaContext = [
    `Player goal: ${idea.playerGoal}.`,
    `Interaction pattern: ${idea.interactionPattern}.`,
    `Mechanic: ${idea.mechanic}.`,
    `Player action: ${idea.playerAction}.`,
    `Game state: ${idea.gameState}.`,
    `Decision: ${idea.decision}.`,
    `Rules: ${idea.rules}.`,
    `Feedback: ${idea.feedback}.`,
    `Visual direction: ${idea.imagePrompt}.`,
  ].join(" ");

  return `${IDEA_IMAGE_SYSTEM_PROMPT}\n${ideaContext}`;
}
