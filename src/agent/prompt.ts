export function selectSystemPrompt(source: string, section?: string): string {
  if (!section) return source.trim();

  const startMarker = `<!-- prompt:${section} -->`;
  const endMarker = `<!-- /prompt:${section} -->`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`System prompt section is missing or invalid: ${section}`);
  }

  return source.slice(start + startMarker.length, end).trim();
}
