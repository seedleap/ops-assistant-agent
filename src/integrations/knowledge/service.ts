import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
