import type { AppConfig } from "../../config.js";

export interface IdeaImageArtifact {
  bytes: Buffer;
  mimeType: "image/png";
  model: string;
}

export interface IdeaImageGenerator {
  generate(input: { workflowId: string; ideaId: string; prompt: string }): Promise<IdeaImageArtifact>;
}

function normalizeAzureBaseUrl(value: string): string {
  const base = value.replace(/\/$/, "");
  if (/\/openai\/v1$/i.test(base)) return base;
  return `${base}/openai/v1`;
}

export class AzureIdeaImageGenerator implements IdeaImageGenerator {
  constructor(private readonly config: AppConfig) {}

  async generate(input: { workflowId: string; ideaId: string; prompt: string }): Promise<IdeaImageArtifact> {
    if (this.config.assistantDryRun) return this.writeDryRunImage(input);
    const { baseUrl, apiKey, model, quality, timeoutMs } = this.config.ideaImage;
    if (!baseUrl || !apiKey) {
      throw new Error("Idea image generation is not configured");
    }

    const response = await fetch(`${normalizeAzureBaseUrl(baseUrl)}/images/generations`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        size: this.config.ideaImage.size,
        quality,
        background: this.config.ideaImage.background,
        output_format: this.config.ideaImage.outputFormat,
      }),
    });
    const body = await response.json().catch(() => ({})) as {
      data?: Array<{ b64_json?: string; url?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message || `Image API failed: ${response.status}`);
    const item = body.data?.[0];
    let bytes: Buffer;
    if (item?.b64_json) {
      bytes = Buffer.from(item.b64_json, "base64");
    } else if (item?.url) {
      const imageUrl = new URL(item.url);
      if (imageUrl.protocol !== "https:") throw new Error("Generated image URL must use HTTPS");
      const imageResponse = await fetch(item.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!imageResponse.ok) throw new Error(`Generated image download failed: ${imageResponse.status}`);
      const contentType = imageResponse.headers.get("content-type") || "";
      if (contentType && !contentType.toLowerCase().startsWith("image/")) throw new Error("Generated image URL did not return an image");
      const contentLength = Number(imageResponse.headers.get("content-length") || 0);
      if (contentLength > 20 * 1024 * 1024) throw new Error("Generated image exceeds 20 MiB");
      bytes = Buffer.from(await imageResponse.arrayBuffer());
    } else {
      throw new Error("Image API returned no image data");
    }
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error("Generated image size is invalid");
    return { bytes, mimeType: "image/png", model };
  }

  private async writeDryRunImage(input: { workflowId: string; ideaId: string }): Promise<IdeaImageArtifact> {
    // A 1x1 PNG keeps dry-run fully offline while preserving the real response contract.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    return { bytes: png, mimeType: "image/png", model: "dry-run-placeholder" };
  }
}
