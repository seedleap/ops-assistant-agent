import type { CreatorMemoryRecord, ISODateString } from "../../domain/types.js";

const MAX_PREFERENCES = 8;

function cleanValue(value: string): string | undefined {
  const cleaned = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[。.!！?？]+$/g, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 120) return undefined;
  return cleaned;
}

function extractPreferences(text: string): string[] {
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
  timezone?: string,
): CreatorMemoryRecord {
  let stablePreferences = [...(previous?.stablePreferences ?? [])];
  for (const message of userMessages) {
    stablePreferences = mergeRecent(stablePreferences, extractPreferences(message), MAX_PREFERENCES);
  }
  return {
    userId,
    schemaVersion: 2,
    stablePreferences,
    ...(timezone || previous?.timezone ? { timezone: timezone || previous?.timezone } : {}),
    updatedAt,
  };
}
