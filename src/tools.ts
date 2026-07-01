import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export function createQueryOpsDataTool(dataFile: string): ToolDefinition {
  return {
    name: "query_ops_data",
    label: "Query Ops Data",
    description: "Read operational metric data from the configured JSON data source.",
    parameters: Type.Object({
      metric: Type.Optional(Type.String({ description: "Metric name to filter, such as dau or new_users." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of rows to return." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { metric?: unknown; limit?: unknown };
      const payload = await readJsonFile(dataFile) as { metrics?: Array<Record<string, unknown>> };
      const metric = typeof args.metric === "string" ? args.metric : undefined;
      const limit = typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : 20;
      const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];
      const filtered = metric ? metrics.filter((row) => row.name === metric) : metrics;
      return {
        content: [{ type: "text", text: JSON.stringify({ ...payload, metrics: filtered.slice(0, limit) }, null, 2) }],
        details: { count: filtered.length },
      };
    },
  };
}

export function createListSkillDocsTool(skillsDir: string): ToolDefinition {
  return {
    name: "list_skill_docs",
    label: "List Skill Docs",
    description: "List available skill document directories.",
    parameters: Type.Object({}),
    execute: async () => {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      return {
        content: [{ type: "text", text: JSON.stringify({ skills: names }, null, 2) }],
        details: { count: names.length },
      };
    },
  };
}

export function createReadSkillDocTool(skillsDir: string): ToolDefinition {
  const root = resolve(skillsDir);
  return {
    name: "read_skill_doc",
    label: "Read Skill Doc",
    description: "Read a skill's SKILL.md document by skill directory name.",
    parameters: Type.Object({
      skillName: Type.String({ description: "Skill directory name." }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { skillName?: unknown };
      const skillName = typeof args.skillName === "string" ? args.skillName.trim() : "";
      if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
        return {
          content: [{ type: "text", text: "Invalid skillName. Use only letters, numbers, hyphens, or underscores." }],
          details: { ok: false },
          isError: true,
        };
      }
      const filePath = resolve(join(root, skillName, "SKILL.md"));
      if (!filePath.startsWith(root)) {
        return {
          content: [{ type: "text", text: "Invalid skill path." }],
          details: { ok: false },
          isError: true,
        };
      }
      const content = await readFile(filePath, "utf8");
      return {
        content: [{ type: "text", text: content }],
        details: { ok: true, filePath },
      };
    },
  };
}
