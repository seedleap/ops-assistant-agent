import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../../config.js";

export interface StoredIdeaAsset {
  url: string;
  storage: "local" | "s3";
}

export interface IdeaAssetStore {
  put(input: {
    userId: string;
    projectId?: string;
    workflowId: string;
    ideaId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<StoredIdeaAsset>;
}

function safeSegment(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

export function ideaAssetKey(config: AppConfig["ideaAssets"], input: {
  userId: string;
  projectId?: string;
  workflowId: string;
  ideaId: string;
}): string {
  const prefix = config.prefix.replace(/^\/+|\/+$/g, "");
  return [
    prefix,
    safeSegment(input.userId, "user"),
    safeSegment(input.projectId || "unscoped", "unscoped"),
    safeSegment(input.workflowId, "workflow"),
    `${safeSegment(input.ideaId, "idea")}.png`,
  ].join("/");
}

export class LocalIdeaAssetStore implements IdeaAssetStore {
  constructor(private readonly config: AppConfig) {}

  async put(input: Parameters<IdeaAssetStore["put"]>[0]): Promise<StoredIdeaAsset> {
    const outputDir = join(this.config.dataDir, "idea-images");
    await mkdir(outputDir, { recursive: true });
    const filename = `${safeSegment(input.workflowId, "workflow")}-${safeSegment(input.ideaId, "idea")}.png`;
    await writeFile(join(outputDir, filename), input.bytes);
    return { url: `/ideas/assets/${filename}`, storage: "local" };
  }
}

export class S3IdeaAssetStore implements IdeaAssetStore {
  private readonly region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  private readonly client = new S3Client({
    region: this.region,
  });

  constructor(private readonly config: AppConfig) {
  }

  async put(input: Parameters<IdeaAssetStore["put"]>[0]): Promise<StoredIdeaAsset> {
    const key = ideaAssetKey(this.config.ideaAssets, input);
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.ideaAssets.bucket,
      Key: key,
      Body: input.bytes,
      ContentType: input.mimeType,
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: {
        workflow: safeSegment(input.workflowId, "workflow"),
        idea: safeSegment(input.ideaId, "idea"),
      },
    }));
    const cdn = this.config.ideaAssets.cdnBaseUrl.replace(/\/$/, "");
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = `${cdn}/${encodedKey}`;
    return { url, storage: "s3" };
  }
}

export function createIdeaAssetStore(config: AppConfig): IdeaAssetStore {
  return config.ideaAssets.storage === "s3"
    ? new S3IdeaAssetStore(config)
    : new LocalIdeaAssetStore(config);
}
