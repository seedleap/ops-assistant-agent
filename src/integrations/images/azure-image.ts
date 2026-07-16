import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export type ImageQuality = "low" | "medium" | "high";

export interface AzureImageConfig {
  baseUrl?: string;
  apiKey?: string;
  deployment: string;
  timeoutMs: number;
}

export interface GenerateImageInput {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  quality?: ImageQuality;
  transparent?: boolean;
}

export interface GenerateImageResult {
  provider: "azure-ai";
  model: string;
  b64Json: string;
  mimeType: "image/png";
  size: string;
}

const SIZE_BY_RATIO: Record<ImageAspectRatio, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "4:3": "1024x1024",
  "3:4": "1024x1536",
};

function endpointFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/generations`;
}

export class AzureImageClient {
  constructor(
    private readonly config: AzureImageConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(input: GenerateImageInput): Promise<GenerateImageResult> {
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new Error("Azure image configuration is missing AZURE_IMAGE_BASE_URL or AZURE_IMAGE_API_KEY");
    }
    const size = SIZE_BY_RATIO[input.aspectRatio ?? "1:1"];
    const response = await this.fetchImpl(endpointFor(this.config.baseUrl), {
      method: "POST",
      headers: {
        "api-key": this.config.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.deployment,
        prompt: input.prompt,
        size,
        quality: input.quality ?? "low",
        background: input.transparent ? "transparent" : "opaque",
        output_format: "png",
        n: 1,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure image API ${response.status}: ${text.slice(0, 300)}`);
    }
    const body = await response.json() as { data?: Array<{ b64_json?: string }> };
    const b64Json = body.data?.[0]?.b64_json;
    if (!b64Json) throw new Error("Azure image API returned no image data");
    return { provider: "azure-ai", model: this.config.deployment, b64Json, mimeType: "image/png", size };
  }
}

/**
 * 预注册但不默认绑定到 Agent Profile 的生图工具。
 * 未来接入资产存储后，可在特定 Profile 中显式加入 generate_image。
 */
export function createGenerateImageTool(client: AzureImageClient): ToolDefinition {
  return {
    name: "generate_image",
    label: "生成图片",
    description: "使用 Azure GPT Image 生成一张静态图片。当前仅作为能力预注册，不由默认 Agent 调用。",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 8_000, description: "图片内容和风格描述。" }),
      aspectRatio: Type.Optional(Type.Union([
        Type.Literal("1:1"), Type.Literal("16:9"), Type.Literal("9:16"), Type.Literal("4:3"), Type.Literal("3:4"),
      ])),
      quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
      transparent: Type.Optional(Type.Boolean({ description: "是否需要透明背景。" })),
    }),
    execute: async (_toolCallId, params) => {
      const result = await client.generate(params as GenerateImageInput);
      return {
        content: [{ type: "text", text: `图片已生成：model=${result.model}, size=${result.size}, mimeType=${result.mimeType}` }],
        details: result,
      };
    },
  };
}
