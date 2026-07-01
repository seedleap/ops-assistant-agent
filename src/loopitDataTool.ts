import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { queryLoopitData, type LoopitCommentSort, type LoopitDataInclude } from "./loopitDataGateway.js";

export function createQueryLoopitDataTool(dataFile: string): ToolDefinition {
  return {
    name: "query_loopit_data",
    label: "Query Loopit Data",
    description: "Query Loopit user/project data by UID or PID, including project consumption, prompt, comments, and profile.",
    parameters: Type.Object({
      uid: Type.Optional(Type.String({ description: "User id." })),
      pid: Type.Optional(Type.String({ description: "Project id." })),
      include: Type.Optional(Type.Array(Type.Union([
        Type.Literal("projects"),
        Type.Literal("profile"),
        Type.Literal("consumption"),
        Type.Literal("prompt"),
        Type.Literal("comments"),
      ]))),
      startDate: Type.Optional(Type.String({ description: "Consumption start date, inclusive, YYYY-MM-DD." })),
      endDate: Type.Optional(Type.String({ description: "Consumption end date, inclusive, YYYY-MM-DD." })),
      limit: Type.Optional(Type.Number({ description: "Max projects or comments to return." })),
      sortBy: Type.Optional(Type.Union([Type.Literal("latest"), Type.Literal("hot")])),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        uid?: unknown;
        pid?: unknown;
        include?: unknown;
        startDate?: unknown;
        endDate?: unknown;
        limit?: unknown;
        sortBy?: unknown;
      };
      const result = await queryLoopitData(dataFile, {
        uid: typeof args.uid === "string" ? args.uid : undefined,
        pid: typeof args.pid === "string" ? args.pid : undefined,
        include: Array.isArray(args.include) ? args.include.filter(isInclude) : undefined,
        startDate: typeof args.startDate === "string" ? args.startDate : undefined,
        endDate: typeof args.endDate === "string" ? args.endDate : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        sortBy: isSortBy(args.sortBy) ? args.sortBy : undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { ok: result.ok, source: result.source },
        isError: !result.ok,
      };
    },
  };
}

function isInclude(value: unknown): value is LoopitDataInclude {
  return value === "projects" ||
    value === "profile" ||
    value === "consumption" ||
    value === "prompt" ||
    value === "comments";
}

function isSortBy(value: unknown): value is LoopitCommentSort {
  return value === "latest" || value === "hot";
}
