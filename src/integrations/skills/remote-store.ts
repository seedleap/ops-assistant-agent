import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rm, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { extract } from "tar";
import type { SkillManifest, RemoteSkillRef } from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface RemoteSkillStoreConfig {
  bucket?: string;
  prefix: string;
  cacheDir: string;
  timeoutMs: number;
  maxBytes: number;
  enabled: boolean;
}

function assertRef(ref: RemoteSkillRef): void {
  if (!ID_RE.test(ref.id)) throw new Error(`invalid remote skill id: ${ref.id}`);
  if (!VERSION_RE.test(ref.version)) throw new Error(`invalid remote skill version: ${ref.version}`);
}

function manifestKey(config: RemoteSkillStoreConfig, ref: RemoteSkillRef): string {
  return `${config.prefix.replace(/^\/+|\/+$/g, "")}/${ref.id}/versions/${ref.version}/manifest.json`;
}

async function bodyBytes(body: unknown, maxBytes: number): Promise<Buffer> {
  const value = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!value?.transformToByteArray) throw new Error("S3 object body is unavailable");
  const bytes = Buffer.from(await value.transformToByteArray());
  if (bytes.length > maxBytes) throw new Error(`remote skill object exceeds ${maxBytes} bytes`);
  return bytes;
}

export class RemoteSkillStore {
  private readonly client?: S3Client;

  constructor(private readonly config: RemoteSkillStoreConfig) {
    if (config.enabled) {
      if (!config.bucket) throw new Error("SKILL_S3_BUCKET is required when remote skills are enabled");
      this.client = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1" });
    }
  }

  async materialize(ref: RemoteSkillRef, targetDir: string): Promise<SkillManifest> {
    // 每次会话先拿 Manifest 再拿包，确保执行内容和版本引用一致。
    assertRef(ref);
    if (!this.client || !this.config.bucket) throw new Error("remote skill store is disabled");

    const manifest = await this.getJson<SkillManifest>(manifestKey(this.config, ref));
    if (manifest.id !== ref.id || manifest.version !== ref.version || !manifest.packageKey || !manifest.sha256) {
      throw new Error(`invalid manifest for ${ref.id}@${ref.version}`);
    }
    const archive = await this.getObject(manifest.packageKey);
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== manifest.sha256) throw new Error(`remote skill checksum mismatch for ${ref.id}@${ref.version}`);
    if (manifest.sizeBytes !== undefined && archive.length !== manifest.sizeBytes) {
      throw new Error(`remote skill size mismatch for ${ref.id}@${ref.version}`);
    }

    const cache = join(resolve(this.config.cacheDir), ref.id, ref.version, manifest.sha256);
    const cachedSkill = join(cache, "SKILL.md");
    if (!existsSync(cachedSkill)) {
      const staging = `${cache}.tmp-${process.pid}-${Date.now()}`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const archivePath = join(staging, "package.tgz");
      await writeFile(archivePath, archive, { flag: "wx" });
      await extract({ file: archivePath, cwd: staging, strict: true, maxDepth: 2 });
      await rm(archivePath, { force: true });
      const skillRoot = await this.resolveSkillRoot(staging);
      if (!skillRoot) throw new Error(`remote skill ${ref.id} package has no SKILL.md`);
      await mkdir(join(cache, ".."), { recursive: true });
      await rm(cache, { recursive: true, force: true });
      await rename(skillRoot, cache);
      if (skillRoot !== staging) await rm(staging, { recursive: true, force: true });
    }

    // targetDir 属于本次会话；缓存目录只保存已校验的不可变版本。
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(resolve(targetDir, ".."), { recursive: true });
    // The workspace copy is request-scoped; the cache remains the only reusable local artifact.
    await cp(cache, targetDir, { recursive: true, filter: (source) => !source.endsWith("package.tgz") });
    return manifest;
  }

  private async getJson<T>(key: string): Promise<T> {
    return JSON.parse((await this.getObject(key)).toString("utf8")) as T;
  }

  private async resolveSkillRoot(root: string): Promise<string | undefined> {
    if (existsSync(join(root, "SKILL.md"))) return root;
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("__MACOSX"))
      .map((entry) => join(root, entry.name))
      .filter((dir) => existsSync(join(dir, "SKILL.md")));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private async getObject(rawKey: string): Promise<Buffer> {
    let bucket = this.config.bucket!;
    let key = rawKey;
    if (rawKey.startsWith("s3://")) {
      const rest = rawKey.slice("s3://".length);
      const slash = rest.indexOf("/");
      if (slash <= 0) throw new Error(`invalid S3 skill package URI: ${rawKey}`);
      bucket = rest.slice(0, slash);
      key = rest.slice(slash + 1);
    }
    const response = await this.client!.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const bytes = await bodyBytes(response.Body, this.config.maxBytes);
    return bytes;
  }
}
