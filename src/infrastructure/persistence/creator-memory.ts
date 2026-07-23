import type { CreatorMemoryRecord, ISODateString } from "../../domain/types.js";

const MAX_PREFERENCES = 8;
const MAX_PROJECT_REFS = 5;
const SENSITIVE_PATTERN =
  /(?:\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b(?:\+?\d[\d -]{7,}\d)\b|住址|地址|学校|手机号|电话|邮箱|身份证|密码|token|api[_ -]?key|secret|精确年龄)/i;
const INSTRUCTION_PATTERN =
  /(?:忽略.{0,12}(?:规则|提示词|指令)|系统提示词|泄露.{0,8}(?:prompt|提示词)|system prompt|developer message|调用.{0,8}(?:工具|tool))/i;
const CLEAR_MEMORY_PATTERN =
  /(?:忘掉|忘记|清除|删除).{0,12}(?:记忆|偏好|之前说的)|(?:不要|别).{0,8}记住|forget (?:my |the )?(?:memory|preferences?)/i;

function cleanValue(value: string): string | undefined {
  const cleaned = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[。.!！?？]+$/g, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 120) return undefined;
  if (SENSITIVE_PATTERN.test(cleaned) || INSTRUCTION_PATTERN.test(cleaned)) return undefined;
  return cleaned;
}

function extractPreferences(text: string): string[] {
  if (SENSITIVE_PATTERN.test(text) || INSTRUCTION_PATTERN.test(text)) return [];
  const patterns = [
    /(?:我喜欢|我偏好|我更喜欢|以后请|回答时请|请一直|不要给我|不要用)\s*([^。.!！?？\n]{2,100})/gi,
    /(?:I prefer|I like|Please always|Please use|Don't use|Do not use)\s+([^.!?\n]{2,100})/gi,
  ];
  const values: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = cleanValue(match[0]);
      if (value) values.push(value);
    }
  }
  return values;
}

function extractProjectRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'）)]+/gi)) {
    const value = match[0].replace(/[，,。.!！?？]+$/g, "");
    if (/loopit/i.test(value) && value.length <= 512) refs.push(value);
  }
  for (const match of text.matchAll(/\bp_[A-Za-z0-9_-]{2,126}\b/g)) refs.push(match[0]);
  return refs;
}

function mergeRecent(existing: readonly string[], additions: readonly string[], limit: number): string[] {
  const ordered = [...existing];
  for (const value of additions) {
    const previous = ordered.indexOf(value);
    if (previous >= 0) ordered.splice(previous, 1);
    ordered.push(value);
  }
  return ordered.slice(-limit);
}

export function buildCreatorMemory(
  userId: string,
  userMessages: readonly string[],
  updatedAt: ISODateString,
  previous?: CreatorMemoryRecord,
): CreatorMemoryRecord {
  let stablePreferences = [...(previous?.stablePreferences ?? [])];
  let recentProjectRefs = [...(previous?.recentProjectRefs ?? [])];
  for (const message of userMessages) {
    if (CLEAR_MEMORY_PATTERN.test(message)) {
      stablePreferences = [];
      recentProjectRefs = [];
      continue;
    }
    stablePreferences = mergeRecent(stablePreferences, extractPreferences(message), MAX_PREFERENCES);
    recentProjectRefs = mergeRecent(recentProjectRefs, extractProjectRefs(message), MAX_PROJECT_REFS);
  }
  return {
    userId,
    schemaVersion: 1,
    stablePreferences,
    recentProjectRefs,
    updatedAt,
  };
}
