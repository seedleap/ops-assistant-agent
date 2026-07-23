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
  ├─ tool: creator_project_analyze
  ├─ tool: creator_comments_analyze
  ├─ tool: creator_account_summarize
  ├─ platform tool: creator_activity_status
  ├─ generation: turn-2
  └─ final output / usage / status
```

The Agent is one component in a wider creator-operations flow. The operations
console, data platform, activity core and client retain their own authoritative
state; the Agent personalizes and explains confirmed facts but does not own
eligibility, enrollment, task progress, rewards or card state. See
[`CREATOR-OPERATIONS-CONTEXT.md`](CREATOR-OPERATIONS-CONTEXT.md).
The creator-facing scenario architecture, new MCP contracts and the exact delta
from `origin/main` are documented in
[`CREATOR-SUPPORT-ARCHITECTURE.md`](CREATOR-SUPPORT-ARCHITECTURE.md).

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
├── cli/
│   └── loopit-data.ts    # local fixture query CLI
├── concurrency/
│   └── keyedMutex.ts    # same-conversation serialization
├── domain/
│   └── types.ts          # stable conversation, run, schedule and outbox types
├── http/
│   ├── app.ts            # dependency-injected Express application factory
│   └── security.ts       # authentication boundary
├── integrations/
│   ├── knowledge/
│   │   └── service.ts    # managed knowledge documents and admin CRUD
│   └── loopit/
│       ├── mcp-client.ts # remote Loopit data MCP client
│       ├── data-tools.ts # Pi-facing Loopit tool definitions
│       └── local-gateway.ts # local fixture query path
├── infrastructure/
│   ├── persistence/
│   │   └── json-store.ts # current local MVP persistence
│   └── scheduler/
│       └── outreach-scheduler.ts # current local MVP scheduler
├── runtime/
│   ├── atomic-file.ts    # atomic config writes
│   └── paths.ts          # filesystem-safe conversation workspaces
├── observability/
│   ├── index.ts         # OTel/Langfuse initialization and shutdown
│   ├── langfuse.ts      # Agent/turn/tool trace hierarchy
│   └── sanitize.ts      # trace redaction and bounded payloads
└── main.ts              # process composition, listen and shutdown
```

## Agent profiles

### Remote business Skills

默认 Skill 与远程业务 Skill 都遵循 Pi 的标准目录约定：每个目录必须包含大写
`SKILL.md`，运行时物料化到当前工作目录的 `.pi/skills/<name>/`。Profile
通过 `localSkills` 声明镜像内置的默认 Skill，通过不可变的 `id + version` 引用远程
Skill；远程 Skill 由 `RemoteSkillStore` 读取 Manifest、下载 tgz、校验 SHA-256。
Pi `DefaultResourceLoader` 自动发现这些目录，把名称和描述注册到 system prompt；
模型只在任务匹配时使用只读 `read` 工具加载全文。工作目录只是会话级副本，远程
缓存路径也必须按 `id/version/sha256` 隔离。

远程 Skill 只承载稳定的运营规则、生成规范和参考资料。Creator Score、活动
资格、任务进度、奖励和 IM 动作仍由外部系统通过 MCP 提供；Agent 不得从 Skill
文本推断这些事实。远程版本不可用时，会话应明确失败并进入 trace，避免静默执行
旧规则；本地默认 Skill 仅作为随镜像发布的稳定知识，不替代外部业务事实。

### 文本会话恢复

文本运营不使用 Carmack 的 codebase snapshot 语义，而是分开保存
`Conversation → Session → Run → Message`。Pi 的 Session JSONL 是近期上下文
缓存；`state.json`（后续迁移到数据库）中的 Message 才是业务事实。显式
`sessionMode=new|continue` 控制是否开启新的上下文，Session 文件丢失时用
摘要和最近消息重建新 Session。启用 `CONVERSATION_ARCHIVE_ENABLED` 后，服务
会把可见消息和摘要异步压缩成 gzip JSONL 上传 S3，启动新请求时可按
`userId + imThreadId` 从归档补回本地状态；thinking 不进入消息归档。

There are two profiles:

- `creator-chat`: full creator-support tool set for analysis, inspiration, activities and product guidance; interactive compaction enabled.
- `creator-outreach`: value-gated outreach tool set with authoritative activity status; fewer turns and no cross-run compaction.

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

Gemini 运行约束：

- 系统提示词和知识库索引在会话内保持稳定，动态 UID 只放在本轮用户提示中，尽量保留可复用的缓存前缀。
- 只把可见文本写入响应、会话后续处理和 Langfuse；thinking parts 不作为业务上下文传递。
- Pi 的 `input`、`cacheRead`、`cacheWrite` token 会同时记录，并按 `cacheRead / (input + cacheRead + cacheWrite)` 计算命中率，便于发现提示词漂移或缓存失效。

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
