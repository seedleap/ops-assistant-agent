# Ops Assistant Agent Architecture

## Design principles

- Pi owns model resolution, session history, retries, compaction and lifecycle events.
- This project owns Loopit-specific prompts, tools and outreach decisions.
- Production integrations stay behind explicit business tools; the model never receives generic SQL or filesystem tools.
- Agent profiles are static, typed configuration. A request may choose an allowed model, but cannot change the tool boundary.
- Observability is optional and non-blocking. Trace export failures never fail an Agent run.

## Runtime flow

```text
HTTP / scheduler
  → OpsAssistant
  → AgentProfile
  → OpsSessionFactory
  → Pi AgentSession
  → Loopit custom tools
  → MCP client (Streamable HTTP)
  → external Loopit data service
```

Langfuse observes the same Pi lifecycle:

```text
Agent trace
  ├─ generation: turn-1
  ├─ tool: query_creator_works
  ├─ tool: query_work_overview
  ├─ generation: turn-2
  └─ final output / usage / status
```

The Agent is one component in a wider creator-operations flow. The operations
console, data platform, activity core and client retain their own authoritative
state; the Agent personalizes and explains confirmed facts but does not own
eligibility, enrollment, task progress, rewards or card state. See
[`CREATOR-OPERATIONS-CONTEXT.md`](CREATOR-OPERATIONS-CONTEXT.md).

## Source layout

```text
src/
├── agent/
│   ├── assistant.ts     # one Agent run and timeout boundary
│   ├── events.ts        # Pi events mapped to the HTTP stream contract
│   ├── extensions.ts    # provider parameters and max-turn guard
│   ├── models.ts        # AuthStorage, ModelRegistry and model whitelist
│   ├── profiles/        # one typed composition root per Agent
│   │   ├── catalog.ts   # keyed registry; Profile IDs derive from its keys
│   │   ├── creator-chat.ts
│   │   ├── creator-outreach.ts
│   │   ├── registry.ts
│   │   └── types.ts
│   └── session.ts       # the only createAgentSession call site
├── concurrency/
│   └── keyedMutex.ts    # same-conversation serialization
├── runtime/
│   ├── atomicFile.ts     # atomic config writes
│   └── paths.ts          # filesystem-safe conversation workspaces
├── observability/
│   ├── index.ts         # OTel/Langfuse initialization and shutdown
│   ├── langfuse.ts      # Agent/turn/tool trace hierarchy
│   └── sanitize.ts      # trace redaction and bounded payloads
├── opsDataTools.ts      # Loopit data tool definitions
├── knowledge.ts         # managed knowledge and read_knowledge
├── scheduler.ts         # current local MVP scheduler
├── store.ts             # current local MVP persistence
├── server.ts            # dependency-injected Express application factory
└── main.ts              # process composition, listen and shutdown
```

## Agent profiles

There are two profiles:

- `creator-chat`: full read-only diagnostic tool set, interactive compaction enabled.
- `creator-outreach`: smaller tool set, fewer turns and no cross-run compaction.

Each profile definition is a small, static composition root that controls:

- its own system-prompt file;
- exact provider and model ID;
- thinking level and temperature;
- maximum turns and wall-clock timeout;
- retry policy;
- tool allowlist;
- compaction policy;
- stable Langfuse trace name.

Production model selection is constrained by `MODEL_WHITELIST`. Unknown or disallowed models fail explicitly instead of silently falling back, so model experiments remain attributable.

`catalog.ts` is the only Profile registry. `AgentProfileId` is derived from its
keys, so adding a definition does not require maintaining a separate ID union or
resolver branch. Profile TypeScript files own versioned behavior and defaults;
optional environment overrides are keyed by the same derived ID. Credentials,
MCP endpoints, JWT, storage and Langfuse remain infrastructure configuration.
`OpsSessionFactory` only translates a resolved Profile into Pi services and
`createAgentSession()` options.

Prompt, model and runtime values remain grouped in both the static definition and
the resolved runtime Profile. Resolution only adds the registry ID, absolute
prompt path and optional deployment overrides; it does not flatten the object into
a second shape.

## Pi integration

The project uses `@earendil-works/pi-coding-agent` and its current API:

- `ModelRegistry.create()` and `AuthStorage.create()` are initialized once per process.
- `DefaultResourceLoader` replaces the former handwritten `ResourceLoader` stub.
- Global and workspace extension/skill discovery is disabled for the service runtime.
- Only explicit inline extensions are loaded.
- `createAgentSession({ tools: string[], customTools })` uses the current tool-name allowlist behavior.
- `SessionManager` owns persisted model context.
- `SettingsManager` owns retry and compaction configuration.
- Native `message_update` and `tool_execution_*` events drive SSE and trace spans.

## Model parameters

Pi receives `thinkingLevel` directly. Provider-specific payload parameters are isolated in `createModelParametersExtension()`:

- Vertex requests receive `config.temperature`.
- Gemini `includeThoughts` is forced to `false`.
- OpenAI/OpenRouter requests receive top-level `temperature`.

Do not add provider payload mutation elsewhere in the application.

## Langfuse contract

One Agent run maps to one trace:

- trace name: profile `traceName`;
- trace user: internal user ID;
- trace session: IM thread ID;
- trace metadata: run type, semantic prompt version, exact prompt hash, model/provider, thinking level, temperature and max turns;
- generation observations: model output, token usage and cost per turn;
- tool observations: sanitized args/output and error status;
- final trace: output, total usage, cost and tool-call count.

Tool implementations expose internal diagnostic errors through `details.error`. The model-facing content remains concise; the Langfuse tool span maps `details.error` to `statusMessage`.

Trace payloads redact credentials, bearer tokens, SQL-like fields, private keys and data URLs. Strings and collections are bounded before export.

## Dependency policy

Runtime dependencies remain intentionally small:

- `@earendil-works/pi-coding-agent`: Agent runtime.
- `@modelcontextprotocol/sdk`: official Streamable HTTP client for the external Loopit data service.
- `@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/sdk-node`: optional tracing.
- `@sinclair/typebox`: Pi tool schemas.
- `express`, `cors`, `helmet`, `express-rate-limit`, `express-jwt`: HTTP and security boundary.
- `pino`, `pino-http`: structured process and request logs with credential redaction.
- `async-mutex`: serialized atomic writes for the local MVP store.
- `zod`, `dotenv`: validated environment and request configuration.

Use native `fetch`, `crypto`, `Date`, Node test runner and filesystem APIs. Do not add Axios, a DI framework, an event library or another Agent framework.

## Configuration and delivery

- `src/config.ts` is the single environment boundary. Zod validates all runtime values before services are created.
- Production configuration requires JWT auth, explicit CORS origins and a disabled static UI; local/test environments can remain lightweight.
- User and thread IDs never become filesystem path segments. Conversation workspaces use stable hashed keys, and one conversation is serialized before Pi session reuse.
- Invalid values fail fast with the exact environment variable name; production never silently falls back from malformed input.
- The configured interactive and outreach models must both be present in `MODEL_WHITELIST`.
- `tsconfig.json` is the strict editor/test configuration; `tsconfig.build.json` emits only production source to `dist/`.
- `pnpm run check` is the local and CI quality gate: typecheck, tests, then a clean production build.
- The container image uses Node 22.19, runs as a non-root user and excludes local credentials.
- Production APIs use verified HS256 JWTs; health and static assets remain public.
- Helmet, CORS and rate limiting are standard middleware rather than local implementations.

## Deliberately deferred

The current `JsonStore`, local scheduler, configuration UI and outbox remain MVP implementations. Their future replacements should be company services or focused adapters:

- database-backed conversation/outreach repository;
- durable scheduler/queue;
- real segmentation service;
- real IM sender;
- activity eligibility, enrollment, task-progress and reward services;
- authoritative activity-card payloads and client actions;
- externally owned Loopit business APIs behind the stable data MCP contract.

These infrastructure changes are independent from the Pi runtime refactor and should not be embedded into Agent prompts or tools.

## Production topology

The current production topology is deliberately one replica with a persistent
volume. The image seeds default config and knowledge into that volume at startup,
then treats the volume as the runtime source of truth. Kubernetes uses `Recreate`
to prevent overlapping writers during rollout.

This differs intentionally from Carmack's multi-replica/HPA topology. Scaling is
allowed only after `JsonStore`, the local scheduler and outbox move behind shared
durable services. See `docs/DEPLOYMENT.md` for the complete release contract.
