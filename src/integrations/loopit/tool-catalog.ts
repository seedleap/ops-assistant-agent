import type { OpsMcpToolName } from "./mcp-client.js";

/**
 * Agent-facing business tools deliberately differ from the upstream MCP operations.
 * The model sees one tool per high-value workflow; the data service remains free to
 * compose or reuse lower-level query operations behind that stable contract.
 */
export const CREATOR_SUPPORT_TOOL_BINDINGS = {
  query_public_work: "query_public_work",
  analyze_work_comments: "analyze_work_comments",
  query_creator_account_summary: "query_creator_account_summary",
  query_creator_activity_status: "query_creator_activity_status",
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

export type ToolDetailLevel = "summary" | "full";

/**
 * Target envelope for every creator-support MCP result.
 * The external MCP server owns validation against its outputSchema.
 */
export interface CreatorToolResult<TData = Record<string, unknown>> {
  data: TData | null;
  meta: {
    data_as_of?: string;
    time_range?: { start?: string; end?: string; timezone?: string };
    source_refs?: Array<{ source: string; revision?: string; updated_at?: string }>;
    partial?: boolean;
    missing_fields?: string[];
  };
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}
