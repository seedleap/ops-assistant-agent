import type { IdeaWorkflowRecord } from "../domain/types.js";
import type { IdeaAssetStore } from "../integrations/images/idea-asset-store.js";
import type { IdeaImageGenerator } from "../integrations/images/idea-image.js";
import type { JsonStore } from "../infrastructure/persistence/json-store.js";
import type { createIdeaWorkflowTrace } from "../observability/idea-workflow.js";
import { errorMessage } from "../observability/sanitize.js";

export class IdeaImagePipeline {
  constructor(
    private readonly store: JsonStore,
    private readonly images: IdeaImageGenerator,
    private readonly assets: IdeaAssetStore,
  ) {}

  async run(
    trace: ReturnType<typeof createIdeaWorkflowTrace>,
    record: IdeaWorkflowRecord,
    throwIfCanceled: () => void,
  ): Promise<void> {
    let cursor = 0;
    const ideas = record.ideas
      .map((idea, index) => ({ idea, index: index + 1 }))
      .filter(({ idea }) => idea.image.status !== "completed");
    const worker = async (): Promise<void> => {
      while (cursor < ideas.length) {
        const { idea, index } = ideas[cursor++];
        throwIfCanceled();
        const prompt = `Create a polished 9:16 vertical mobile game screenshot, not a poster. Show one active gameplay moment and communicate the mechanic visually. Interaction pattern: ${idea.interactionPattern}. Mechanic: ${idea.mechanic}. Player action: ${idea.playerAction}. Decision: ${idea.decision}. Short loop: ${idea.loop}. Visual direction: ${idea.imagePrompt}. Clearly distinguish actionable targets, predictive signals, current state, and immediate gameplay feedback. Do not show a failure, reset, retry, game-over, or results screen. Do not add weapons, characters, written text, generic buttons, or unrelated objects unless explicitly required by the core gameplay.`;
        const span = trace.startImage(index, { ideaId: idea.id, prompt });
        try {
          const artifact = await this.generateWithRetry({
            workflowId: record.id,
            ideaId: idea.id,
            prompt,
          });
          if (artifact.bytes.length === 0 || artifact.bytes.length > 20 * 1024 * 1024) {
            throw new Error(`generated image size is invalid: ${artifact.bytes.length} bytes`);
          }
          const stored = await this.putWithRetry({
            userId: record.userId,
            projectId: record.projectId,
            workflowId: record.id,
            ideaId: idea.id,
            bytes: artifact.bytes,
            mimeType: artifact.mimeType,
          });
          await this.store.updateIdeaImage(record.id, idea.id, {
            status: "completed",
            url: stored.url,
            mimeType: artifact.mimeType,
            model: artifact.model,
            storage: stored.storage,
          });
          span.finish(
            { ideaId: idea.id, url: stored.url, storage: stored.storage, mimeType: artifact.mimeType },
            undefined,
            { model: artifact.model },
          );
        } catch (error) {
          await this.store.updateIdeaImage(record.id, idea.id, { status: "failed", error: errorMessage(error) });
          span.finish({ ideaId: idea.id, status: "failed" }, error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, ideas.length) }, () => worker()));
  }

  private async generateWithRetry(input: Parameters<IdeaImageGenerator["generate"]>[0]) {
    return retryTransient(() => this.images.generate(input));
  }

  private async putWithRetry(input: Parameters<IdeaAssetStore["put"]>[0]) {
    return retryTransient(() => this.assets.put(input));
  }
}

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = Number((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode || 0);
      const message = error instanceof Error ? error.message : String(error);
      const transient = status === 429 || status >= 500 || /(429|5\d\d|timeout|temporar|network|fetch failed|ECONNRESET|ETIMEDOUT)/i.test(message);
      if (!transient || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}
