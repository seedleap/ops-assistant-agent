import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpsAssistant } from "../agent/assistant.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../infrastructure/persistence/json-store.js";
import type { IdeaImageGenerator } from "../integrations/images/idea-image.js";
import type { IdeaAssetStore } from "../integrations/images/idea-asset-store.js";
import { IdeaWorkflow, IdeaWorkflowConflictError } from "./workflow.js";

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for workflow state");
}

test("IdeaWorkflow runs isolated Pi profiles and returns text plus image", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "idea-workflow-"));
  try {
    const config = loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, ASSISTANT_DRY_RUN: "false" });
    const store = await JsonStore.open(dataDir);
    const calls: string[] = [];
    const agent = {
      run: async (input: { profileId?: string }) => {
        calls.push(input.profileId || "");
        if (input.profileId === "idea-inventor") {
          return JSON.stringify({ kernels: Array.from({ length: 8 }, (_, index) => ({
            id: `k${index + 1}`,
            title: `Kernel ${index + 1}`,
            mechanicFamily: "timing",
            interactionPattern: index % 2 ? "timing" : "drag-track",
            mechanicAnchor: "warned targets become active",
            coreAction: "tap",
            gameState: "target is warned or active",
            playerDecision: "choose a target before timeout",
            tension: "wait for certainty or act early",
            failAndRecovery: "retry current target",
            masteryGrowth: "learn the warning order",
            variationSource: "target positions shuffle",
            themeBinding: "theme controls target state",
            whyFun: "fast mastery",
            antiClone: "warning order changes the decision",
          })) });
        }
        return JSON.stringify({ ideas: Array.from({ length: 2 }, (_, index) => ({
          id: `k${index + 1}`,
          title: `Idea ${index + 1}`,
          summary: "short game idea",
          mechanic: `timed target choice ${index + 1}`,
          interactionPattern: index % 2 ? "timing" : "drag-track",
          playerGoal: "score before timeout",
          playerAction: "tap a target",
          gameState: "target is warned or active",
          decision: "choose before timeout",
          rules: "only warned targets score",
          loop: "observe, choose, resolve",
          failState: "target expires",
          feedback: "target flashes",
          failureRecovery: "retry current target",
          whyFun: "fast mastery",
          prototypeTest: "three loops in 30 seconds",
          difficultyCurve: "warnings shorten twice",
          variationSource: "target positions shuffle",
          first10Seconds: "guided target then normal loops",
          funRisks: "choice may feel automatic",
          bindingRationale: "theme controls target state",
          audit: {
            loopPass: true,
            predictionPass: true,
            interactionPass: true,
            feasibilityPass: true,
            fatalReasons: [],
            evidence: "visible timer and deterministic tap",
            recommendedDowngrade: "none",
          },
          imagePrompt: "portrait game board with a visible timer",
        })) });
      },
    } as unknown as OpsAssistant;
    const imageAttempts = new Map<string, number>();
    const images: IdeaImageGenerator = {
      generate: async ({ ideaId }) => {
        const attempt = (imageAttempts.get(ideaId) || 0) + 1;
        imageAttempts.set(ideaId, attempt);
        if (ideaId === "k1" && attempt < 3) throw new Error("Image API returned no image data");
        return { bytes: Buffer.from("png"), mimeType: "image/png", model: "fake-image" };
      },
    };
    const assets: IdeaAssetStore = {
      put: async ({ ideaId }) => ({ url: `/ideas/assets/${ideaId}.png`, storage: "local" }),
    };

    const input = {
      userId: "u1",
      theme: "garden",
      audience: "casual players",
      emotion: "quick delight",
      duration: "30 seconds",
      count: 2,
    };
    const service = new IdeaWorkflow(config, store, agent, images, assets);
    const workflow = await service.run(input);

    assert.deepEqual(calls, ["idea-inventor", "idea-converger"]);
    assert.equal(workflow.status, "completed");
    assert.equal(workflow.projectId, "idea_create");
    assert.equal(workflow.ideas.length, 2);
    assert.equal(workflow.ideas[0].image.url, "/ideas/assets/k1.png");
    assert.equal(workflow.ideas[0].image.storage, "local");
    assert.equal(imageAttempts.get("k1"), 3);
    assert.equal(workflow.ideas[0].gatePassed, true);
    assert.equal(workflow.ideas[0].audit.evidence, "visible timer and deterministic tap");
    assert.equal(workflow.ideas[0].playerGoal, "score before timeout");
    assert.equal(workflow.metadata.workflowVersion, "idea-workflow-v1");
    assert.ok(workflow.checkpoints.invention);
    assert.equal(workflow.checkpoints.audits, undefined);
    assert.ok(workflow.checkpoints.convergence);
    assert.equal(store.getIdeaWorkflow(workflow.id)?.stage, "complete");

    const replay = await service.start(input, workflow.idempotencyKey);
    assert.equal(replay.created, false);
    assert.equal(replay.workflow.id, workflow.id);
    await assert.rejects(
      () => service.start({ ...input, theme: "different" }, workflow.idempotencyKey),
      IdeaWorkflowConflictError,
    );

    const failedImageIdeas = workflow.ideas.map((idea, index) => index === 0
      ? { ...idea, image: { status: "failed" as const, error: "temporary" } }
      : idea);
    await store.updateIdeaWorkflow(workflow.id, { status: "completed_with_errors", ideas: failedImageIdeas });
    await service.retry(workflow.id, "u1");
    const retried = await waitFor(() => {
      const value = store.getIdeaWorkflow(workflow.id);
      return value?.status === "completed" ? value : undefined;
    });
    assert.equal(retried.attempt, 2);
    assert.equal(retried.ideas[0].image.status, "completed");
    assert.deepEqual(calls, ["idea-inventor", "idea-converger"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
