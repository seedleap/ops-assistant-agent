import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ConversationRecord, ConversationSessionRecord, MessageRecord } from "../../domain/types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ConversationArchiveConfig {
  enabled: boolean;
  bucket?: string;
  prefix: string;
}

export interface ConversationArchive {
  conversation: ConversationRecord;
  sessions: ConversationSessionRecord[];
  messages: MessageRecord[];
}

function keyFor(config: ConversationArchiveConfig, userId: string, threadId: string): string {
  const id = createHash("sha256").update(`${userId}\0${threadId}`).digest("hex").slice(0, 32);
  return `${config.prefix.replace(/^\/+|\/+$/g, "")}/${id}/conversation.jsonl.gz`;
}

async function bodyBuffer(body: unknown): Promise<Buffer> {
  const value = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!value?.transformToByteArray) throw new Error("S3 archive body is unavailable");
  return Buffer.from(await value.transformToByteArray());
}

export class ConversationArchiveStore {
  private readonly client?: S3Client;

  constructor(private readonly config: ConversationArchiveConfig) {
    if (config.enabled) {
      if (!config.bucket) throw new Error("CONVERSATION_ARCHIVE_BUCKET is required when archive is enabled");
      this.client = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1" });
    }
  }

  async put(archive: ConversationArchive): Promise<void> {
    if (!this.client || !this.config.bucket) return;
    const lines = [
      JSON.stringify({ recordType: "conversation", value: archive.conversation }),
      ...archive.sessions.map((value) => JSON.stringify({ recordType: "session", value })),
      ...archive.messages.map((value) => JSON.stringify({ recordType: "message", value })),
    ].join("\n") + "\n";
    const compressed = await gzipAsync(Buffer.from(lines, "utf8"));
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: keyFor(this.config, archive.conversation.userId, archive.conversation.imThreadId),
      Body: compressed,
      ContentType: "application/x-ndjson",
      ContentEncoding: "gzip",
      Metadata: { schema: "ops-conversation-v1" },
    }));
  }

  async get(userId: string, imThreadId: string): Promise<ConversationArchive | null> {
    if (!this.client || !this.config.bucket) return null;
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: keyFor(this.config, userId, imThreadId),
      }));
      const text = (await gunzipAsync(await bodyBuffer(response.Body))).toString("utf8");
      const records = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { recordType: string; value: unknown });
      const conversation = records.find((record) => record.recordType === "conversation")?.value as ConversationRecord | undefined;
      if (!conversation) return null;
      return {
        conversation,
        sessions: records.filter((record) => record.recordType === "session").map((record) => record.value as ConversationSessionRecord),
        messages: records.filter((record) => record.recordType === "message").map((record) => record.value as MessageRecord),
      };
    } catch (error: any) {
      if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }
}
