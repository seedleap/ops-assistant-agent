import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * 知识库 = 由后台配置、agent 可读的若干 md 文档集合。
 * 目前两类：创作者指导(creator_guide) 与 运营活动(ops_activities)。
 * 每类对应 `<skillsDir>/<dir>/docs/*.md`，`<dir>/SKILL.md` 是该 skill 的说明。
 */
export const KNOWLEDGE_COLLECTIONS = {
  creator_guide: { dir: "creator-guide", label: "创作者指导" },
  ops_activities: { dir: "ops-activities", label: "运营活动" },
} as const;

export type KnowledgeCollection = keyof typeof KNOWLEDGE_COLLECTIONS;

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isCollection(value: string): value is KnowledgeCollection {
  return Object.prototype.hasOwnProperty.call(KNOWLEDGE_COLLECTIONS, value);
}

export function isValidDocName(name: string): boolean {
  return NAME_RE.test(name);
}

function docsDir(skillsDir: string, collection: KnowledgeCollection): string {
  return resolve(join(skillsDir, KNOWLEDGE_COLLECTIONS[collection].dir, "docs"));
}

function firstHeading(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

export interface DocMeta {
  name: string;
  title: string;
}

export async function listDocs(skillsDir: string, collection: KnowledgeCollection): Promise<DocMeta[]> {
  const dir = docsDir(skillsDir, collection);
  if (!existsSync(dir)) {
    return [];
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const docs: DocMeta[] = [];
  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    const content = await readFile(join(dir, file), "utf8").catch(() => "");
    docs.push({ name, title: firstHeading(content) || name });
  }
  return docs;
}

export async function readDoc(skillsDir: string, collection: KnowledgeCollection, name: string): Promise<string> {
  if (!isValidDocName(name)) {
    throw new Error(`非法文档名：${name}`);
  }
  return readFile(join(docsDir(skillsDir, collection), `${name}.md`), "utf8");
}

export async function writeDoc(
  skillsDir: string,
  collection: KnowledgeCollection,
  name: string,
  content: string,
): Promise<void> {
  if (!isValidDocName(name)) {
    throw new Error(`非法文档名：${name}（只允许字母/数字/下划线/连字符）`);
  }
  const dir = docsDir(skillsDir, collection);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content, "utf8");
}

export async function deleteDoc(
  skillsDir: string,
  collection: KnowledgeCollection,
  name: string,
): Promise<boolean> {
  if (!isValidDocName(name)) {
    throw new Error(`非法文档名：${name}`);
  }
  const file = join(docsDir(skillsDir, collection), `${name}.md`);
  if (!existsSync(file)) {
    return false;
  }
  await unlink(file);
  return true;
}

/** 把某一类知识库的所有文档拼成一段文本，给 agent 一次读全。 */
export async function readAllConcat(skillsDir: string, collection: KnowledgeCollection): Promise<string> {
  const docs = await listDocs(skillsDir, collection);
  const dir = docsDir(skillsDir, collection);
  const parts: string[] = [];
  for (const doc of docs) {
    const content = await readFile(join(dir, `${doc.name}.md`), "utf8").catch(() => "");
    if (content.trim()) {
      parts.push(content.trim());
    }
  }
  return parts.join("\n\n---\n\n");
}

/** 注入系统提示的"目录"：列出每类知识库现有文档标题，让 agent 知道有什么、何时去读。 */
export async function knowledgeIndex(skillsDir: string): Promise<string> {
  const lines: string[] = ["# 可用知识库（按需用 read_knowledge 读取，别凭空编）"];
  for (const key of Object.keys(KNOWLEDGE_COLLECTIONS) as KnowledgeCollection[]) {
    const docs = await listDocs(skillsDir, key);
    const titles = docs.length ? docs.map((d) => d.title).join("、") : "（暂无）";
    lines.push(`- read_knowledge('${key}')（${KNOWLEDGE_COLLECTIONS[key].label}）：${titles}`);
  }
  return lines.join("\n");
}

export function createReadKnowledgeTool(skillsDir: string): ToolDefinition {
  return {
    name: "read_knowledge",
    label: "读取知识库",
    description:
      "读取后台配置的知识库文档（返回该类全部文档原文）。" +
      "collection=creator_guide 读创作指导（Loopit 能力介绍、热榜 case 解析等）；" +
      "collection=ops_activities 读当前运营活动（活动介绍+链接）。" +
      "聊创作技巧/怎么做爆款/Loopit 能做什么、或聊活动时，先读这里，别自己编。",
    parameters: Type.Object({
      collection: Type.Union([Type.Literal("creator_guide"), Type.Literal("ops_activities")], {
        description: "要读的知识库类别。",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const collection = (params as { collection?: unknown }).collection;
      if (typeof collection !== "string" || !isCollection(collection)) {
        return {
          content: [{ type: "text", text: `未知知识库：${String(collection)}` }],
          details: { ok: false, error: `unknown knowledge collection: ${String(collection)}` },
          isError: true,
        };
      }
      const startedAt = Date.now();
      try {
        const text = await readAllConcat(skillsDir, collection);
        return {
          content: [{ type: "text", text: text || "（该知识库暂无文档）" }],
          details: { ok: true, collection, durationMs: Date.now() - startedAt },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `知识库读取失败：${message}` }],
          details: { ok: false, collection, durationMs: Date.now() - startedAt, error: message },
          isError: true,
        };
      }
    },
  };
}
