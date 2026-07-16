import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type LoopitDataInclude = "projects" | "profile" | "consumption" | "prompt" | "comments";
export type LoopitCommentSort = "latest" | "hot";

interface LoopitUser {
  uid: string;
  displayName?: string;
  region?: string;
}

interface LoopitConsumptionRow {
  date: string;
  vv?: number;
  uv?: number;
  avgWatchSeconds?: number;
  completionRate?: number;
  likeCount?: number;
  shareCount?: number;
}

interface LoopitComment {
  id: string;
  createdAt: string;
  text: string;
  likeCount?: number;
  sentiment?: string;
}

interface LoopitProject {
  pid: string;
  uid: string;
  title?: string;
  status?: string;
  createdAt?: string;
  profile?: Record<string, unknown>;
  prompt?: Record<string, unknown>;
  consumption?: LoopitConsumptionRow[];
  comments?: LoopitComment[];
}

interface LoopitDataFile {
  updatedAt?: string;
  users?: LoopitUser[];
  projects?: LoopitProject[];
}

export interface LoopitDataQueryInput {
  uid?: string;
  pid?: string;
  include?: LoopitDataInclude[];
  startDate?: string;
  endDate?: string;
  limit?: number;
  sortBy?: LoopitCommentSort;
}

export interface LoopitDataQueryResult {
  ok: boolean;
  error?: string;
  query: Required<Pick<LoopitDataQueryInput, "include" | "limit" | "sortBy">> &
    Pick<LoopitDataQueryInput, "uid" | "pid" | "startDate" | "endDate">;
  source: {
    type: "local-json";
    path: string;
    updatedAt?: string;
    generatedAt: string;
  };
  result?: {
    user?: LoopitUser;
    ownership?: {
      pid: string;
      uid: string;
      matches: boolean;
    };
    projects?: Array<Omit<LoopitProject, "prompt" | "consumption" | "comments"> & {
      consumptionSummary?: ConsumptionSummary;
    }>;
    project?: Omit<LoopitProject, "prompt" | "consumption" | "comments">;
    consumption?: {
      rows: LoopitConsumptionRow[];
      summary: ConsumptionSummary;
    };
    prompt?: LoopitProject["prompt"];
    comments?: LoopitComment[];
  };
}

interface ConsumptionSummary {
  days: number;
  vv: number;
  uv: number;
  likeCount: number;
  shareCount: number;
  avgWatchSeconds?: number;
  completionRate?: number;
}

export async function queryLoopitData(
  dataFile: string,
  input: LoopitDataQueryInput,
): Promise<LoopitDataQueryResult> {
  const normalized = normalizeInput(input);
  const sourcePath = resolve(dataFile);
  const data = JSON.parse(await readFile(sourcePath, "utf8")) as LoopitDataFile;
  const source = {
    type: "local-json" as const,
    path: sourcePath,
    updatedAt: data.updatedAt,
    generatedAt: new Date().toISOString(),
  };

  if (!normalized.uid && !normalized.pid) {
    return {
      ok: false,
      error: "Provide at least one of uid or pid.",
      query: normalized,
      source,
    };
  }

  const users = Array.isArray(data.users) ? data.users : [];
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const user = normalized.uid ? users.find((item) => item.uid === normalized.uid) : undefined;
  const project = normalized.pid ? projects.find((item) => item.pid === normalized.pid) : undefined;

  if (normalized.uid && !user && !projects.some((item) => item.uid === normalized.uid)) {
    return {
      ok: false,
      error: `UID not found: ${normalized.uid}`,
      query: normalized,
      source,
    };
  }

  if (normalized.pid && !project) {
    return {
      ok: false,
      error: `PID not found: ${normalized.pid}`,
      query: normalized,
      source,
    };
  }

  if (normalized.uid && project && project.uid !== normalized.uid) {
    return {
      ok: false,
      error: `PID ${project.pid} belongs to UID ${project.uid}, not ${normalized.uid}.`,
      query: normalized,
      source,
      result: {
        user,
        ownership: {
          pid: project.pid,
          uid: normalized.uid,
          matches: false,
        },
      },
    };
  }

  const result: NonNullable<LoopitDataQueryResult["result"]> = {};
  if (user) {
    result.user = user;
  }
  if (project && normalized.uid) {
    result.ownership = {
      pid: project.pid,
      uid: normalized.uid,
      matches: true,
    };
  }

  if (normalized.include.includes("projects") && normalized.uid) {
    const userProjects = projects
      .filter((item) => item.uid === normalized.uid)
      .sort((left, right) => compareDesc(left.createdAt, right.createdAt))
      .slice(0, normalized.limit);
    result.projects = userProjects.map((item) => ({
      ...projectMetadata(item),
      consumptionSummary: summarizeConsumption(filterConsumption(item.consumption || [], normalized)),
    }));
  }

  if (project) {
    if (normalized.include.includes("profile")) {
      result.project = projectMetadata(project);
    }
    if (normalized.include.includes("consumption")) {
      const rows = filterConsumption(project.consumption || [], normalized);
      result.consumption = {
        rows,
        summary: summarizeConsumption(rows),
      };
    }
    if (normalized.include.includes("prompt")) {
      result.prompt = project.prompt;
    }
    if (normalized.include.includes("comments")) {
      result.comments = sortComments(project.comments || [], normalized.sortBy).slice(0, normalized.limit);
    }
  }

  return {
    ok: true,
    query: normalized,
    source,
    result,
  };
}

function normalizeInput(input: LoopitDataQueryInput): LoopitDataQueryResult["query"] {
  const uid = input.uid?.trim() || undefined;
  const pid = input.pid?.trim() || undefined;
  const include: LoopitDataInclude[] = input.include && input.include.length > 0
    ? unique(input.include)
    : pid
      ? ["profile", "consumption", "prompt", "comments"]
      : ["projects"];
  return {
    uid,
    pid,
    include,
    startDate: input.startDate,
    endDate: input.endDate,
    limit: normalizeLimit(input.limit),
    sortBy: input.sortBy || "latest",
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return 20;
  }
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function compareDesc(left?: string, right?: string): number {
  return Date.parse(right || "") - Date.parse(left || "");
}

function projectMetadata(project: LoopitProject): Omit<LoopitProject, "prompt" | "consumption" | "comments"> {
  return {
    pid: project.pid,
    uid: project.uid,
    title: project.title,
    status: project.status,
    createdAt: project.createdAt,
    profile: project.profile,
  };
}

function filterConsumption(rows: LoopitConsumptionRow[], input: Pick<LoopitDataQueryInput, "startDate" | "endDate">): LoopitConsumptionRow[] {
  return rows.filter((row) => {
    if (input.startDate && row.date < input.startDate) {
      return false;
    }
    if (input.endDate && row.date > input.endDate) {
      return false;
    }
    return true;
  });
}

function summarizeConsumption(rows: LoopitConsumptionRow[]): ConsumptionSummary {
  const summary: ConsumptionSummary = {
    days: rows.length,
    vv: sum(rows, "vv"),
    uv: sum(rows, "uv"),
    likeCount: sum(rows, "likeCount"),
    shareCount: sum(rows, "shareCount"),
  };
  if (rows.length > 0) {
    summary.avgWatchSeconds = weightedAverage(rows, "avgWatchSeconds", "vv");
    summary.completionRate = weightedAverage(rows, "completionRate", "vv");
  }
  return summary;
}

function sum(rows: LoopitConsumptionRow[], key: keyof LoopitConsumptionRow): number {
  return rows.reduce((total, row) => total + numberValue(row[key]), 0);
}

function weightedAverage(
  rows: LoopitConsumptionRow[],
  valueKey: keyof LoopitConsumptionRow,
  weightKey: keyof LoopitConsumptionRow,
): number | undefined {
  const totalWeight = sum(rows, weightKey);
  if (totalWeight <= 0) {
    return undefined;
  }
  const weighted = rows.reduce((total, row) => {
    return total + numberValue(row[valueKey]) * numberValue(row[weightKey]);
  }, 0);
  return Number((weighted / totalWeight).toFixed(4));
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sortComments(comments: LoopitComment[], sortBy: LoopitCommentSort): LoopitComment[] {
  const copy = [...comments];
  if (sortBy === "hot") {
    return copy.sort((left, right) => numberValue(right.likeCount) - numberValue(left.likeCount));
  }
  return copy.sort((left, right) => compareDesc(left.createdAt, right.createdAt));
}
