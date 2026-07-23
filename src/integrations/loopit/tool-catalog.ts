import type { OpsMcpToolName } from "./mcp-client.js";

/**
 * Agent-facing business tools deliberately differ from the upstream MCP operations.
 * The model sees one tool per high-value workflow; the data service remains free to
 * compose or reuse lower-level query operations behind that stable contract.
 */
export const CREATOR_SUPPORT_TOOL_BINDINGS = {
  creator_project_analyze: "query_public_work",
  creator_comments_analyze: "analyze_work_comments",
  creator_account_summarize: "query_creator_account_summary",
  creator_activity_status: "query_creator_activity_status",
} as const satisfies Record<string, OpsMcpToolName>;

export type CreatorSupportToolName = keyof typeof CREATOR_SUPPORT_TOOL_BINDINGS;

export const CREATOR_SUPPORT_TOOL_NAMES = Object.freeze(
  Object.keys(CREATOR_SUPPORT_TOOL_BINDINGS) as CreatorSupportToolName[],
);

export const DATA_PRIMITIVE_TOOL_NAMES = [
  "query_creator_works",
  "query_work_profile",
  "query_work_consumption",
  "query_work_comments",
  "query_work_prompt",
  "query_work_overview",
] as const satisfies readonly OpsMcpToolName[];

export type ToolResponseFormat = "concise" | "detailed";

/**
 * Target envelope for every creator-support MCP result.
 * The external MCP server owns validation against its outputSchema.
 */
export interface CreatorSupportResultEnvelope<TFacts = Record<string, unknown>> {
  ok: boolean;
  as_of: string;
  scope: {
    timezone: string;
    window?: { start: string; end: string };
    subject: "creator" | "own_work" | "public_work" | "activity" | "catalog";
  };
  facts?: TFacts;
  missing_fields?: string[];
  source_refs?: Array<{ source: string; revision?: string; updated_at?: string }>;
  truncated?: boolean;
  next_page_token?: string;
}
