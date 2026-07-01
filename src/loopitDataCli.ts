#!/usr/bin/env node
import { resolve } from "node:path";
import { queryLoopitData, type LoopitCommentSort, type LoopitDataInclude, type LoopitDataQueryInput } from "./loopitDataGateway.js";

const VALID_INCLUDES = new Set<LoopitDataInclude>(["projects", "profile", "consumption", "prompt", "comments"]);

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(helpText());
    return;
  }

  const dataFile = resolve(parsed.dataFile || process.env.LOOPIT_DATA_FILE || "./sample-data/loopit-data.json");
  const result = await queryLoopitData(dataFile, parsed.query);
  process.stdout.write(JSON.stringify(result, null, parsed.pretty ? 2 : 0));
  process.stdout.write("\n");
  if (!result.ok) {
    process.exitCode = 2;
  }
}

function parseArgs(args: string[]): {
  help: boolean;
  pretty: boolean;
  dataFile?: string;
  query: LoopitDataQueryInput;
} {
  const query: LoopitDataQueryInput = {};
  let dataFile: string | undefined;
  let pretty = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pretty") {
      pretty = true;
    } else if (arg === "--uid") {
      query.uid = requiredValue(args, ++index, arg);
    } else if (arg === "--pid") {
      query.pid = requiredValue(args, ++index, arg);
    } else if (arg === "--include") {
      query.include = parseIncludes(requiredValue(args, ++index, arg));
    } else if (arg === "--start") {
      query.startDate = requiredValue(args, ++index, arg);
    } else if (arg === "--end") {
      query.endDate = requiredValue(args, ++index, arg);
    } else if (arg === "--limit") {
      query.limit = Number(requiredValue(args, ++index, arg));
    } else if (arg === "--sort") {
      query.sortBy = parseSort(requiredValue(args, ++index, arg));
    } else if (arg === "--data-file") {
      dataFile = requiredValue(args, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${helpText()}`);
    }
  }

  return { help, pretty, dataFile, query };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseIncludes(raw: string): LoopitDataInclude[] {
  return raw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    if (!VALID_INCLUDES.has(item as LoopitDataInclude)) {
      throw new Error(`Invalid include: ${item}. Use one of: ${Array.from(VALID_INCLUDES).join(", ")}`);
    }
    return item as LoopitDataInclude;
  });
}

function parseSort(raw: string): LoopitCommentSort {
  if (raw === "latest" || raw === "hot") {
    return raw;
  }
  throw new Error("Invalid sort. Use latest or hot.");
}

function helpText(): string {
  return `Usage:
  ./bin/ops-data-query --uid <uid> [--limit 20] [--pretty]
  ./bin/ops-data-query --pid <pid> [--include profile,consumption,prompt,comments] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--sort latest|hot] [--limit 20] [--pretty]
  ./bin/ops-data-query --uid <uid> --pid <pid> [--include profile,consumption,prompt,comments] [--pretty]

Options:
  --uid           User id to query.
  --pid           Project id to query.
  --include       Comma-separated fields: projects, profile, consumption, prompt, comments.
  --start         Start date for consumption rows, inclusive.
  --end           End date for consumption rows, inclusive.
  --sort          Comment sort order: latest or hot.
  --limit         Max projects/comments to return. Default 20, max 100.
  --data-file     JSON data file. Defaults to LOOPIT_DATA_FILE or sample-data/loopit-data.json.
  --pretty        Pretty-print JSON.
`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
