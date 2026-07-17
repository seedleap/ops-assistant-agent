# Business API and Multi-user Task Management Design

- 状态：Proposed
- 更新时间：2026-07-17
- 首个落地对象：Idea Generate Workflow
- 适用范围：当前 Express + Pi Agent 服务，以及后续新增的长耗时 Agent 业务接口

## 1. 结论

本项目不应改造成“由 Pi Agent 直接提供业务接口”的服务。目标形态应继续保持清晰分层：

- Express 提供鉴权、参数校验、幂等和用户可见的业务 API；
- PostgreSQL 保存用户可见的任务、阶段、结果和事件，是业务状态唯一真相源；
- Inngest 负责长任务的持久步骤编排、重试、并发和取消；
- Pi Agent 只执行 V1 的玩法内核发散和红队收敛两个模型阶段；
- 图片模型、S3、MCP 等外部能力继续由显式 Integration 适配器调用；
- Langfuse 负责模型观测，不负责业务任务状态；
- 不引入 LangGraph。当前已经使用 Pi 作为 Agent Runtime，再增加 Agent Graph 会制造第二套 Agent 状态和恢复语义。

目标架构：

```text
Client / Loopit App
        │ X-API-Key + uid
        ▼
┌──────────────────────────────┐
│ Express Business API         │
│ auth / validation / idempot. │
└──────────────┬───────────────┘
               │ transaction
               ▼
┌──────────────────────────────┐
│ PostgreSQL                   │
│ tasks / results / events     │◄───────────────┐
│ checkpoints / outbox         │                │
└──────────────┬───────────────┘                │
               │ outbox event                  │ status/result
               ▼                               │
┌──────────────────────────────┐                │
│ Inngest Durable Workflow     │────────────────┘
│ retry / resume / concurrency │
└──────────────┬───────────────┘
               │ step.run
        ┌──────┼────────────┐
        ▼      ▼            ▼
     Pi Agent  GPT Image  S3 / MCP
     Profiles  Generator   Integrations
```

## 2. 当前实现与问题

### 2.1 已有能力

当前实现已经具备轻量任务系统的核心语义：

- `POST /ideas/generate` 创建异步任务并返回 `workflow.id`；
- `GET /ideas/:id` 返回 `status`、`stage`、结果和图片；
- 状态包括 `queued`、`running`、`completed`、`completed_with_errors`、`failed`、`canceled`；
- V1 新任务阶段包括 `queued`、`invent`、`converge`、`images`、`complete`；
- `Idempotency-Key + userId` 防止重复创建；
- 单用户最多允许两个活跃 Idea 任务；
- 发明和红队收敛结果按 checkpoint 保存；
- 进程重启时会恢复 `queued/running` 任务；
- 单个任务最多并发生成两张图片；
- 生产 JWT 模式要求 `token.sub === userId`。

对应代码：

- [`src/http/idea-router.ts`](../src/http/idea-router.ts)：提交与查询接口；
- [`src/ideas/workflow.ts`](../src/ideas/workflow.ts)：任务状态机和进程内调度；
- [`src/infrastructure/persistence/json-store.ts`](../src/infrastructure/persistence/json-store.ts)：JSON 持久化和单用户容量控制；
- [`src/ideas/image-pipeline.ts`](../src/ideas/image-pipeline.ts)：图片并发和部分失败处理；
- [`src/main.ts`](../src/main.ts)：启动恢复未完成任务。

### 2.2 当前边界

当前方案只适合单实例 MVP：

| 问题 | 当前表现 | 多用户影响 |
| --- | --- | --- |
| 状态存储 | 单文件 `data/state.json` | 多实例会覆盖写入，无法水平扩容 |
| 调度 | `activeJobs: Map` 存在 Node 进程内 | 进程退出会丢失执行租约，多实例可能重复执行 |
| 查询 | 只能按已知 task ID 查询 | 用户无法查看自己的任务历史 |
| 进度通知 | 客户端轮询 | 可用，但没有可恢复的实时事件流 |
| 并发 | 仅限制单用户活跃任务数 | 没有全局模型和图片接口并发保护 |
| 取消与重试 | Service 已有方法 | 尚未暴露 HTTP API |
| 鉴权 | 开发环境可关闭 JWT | 不能用于真实多用户隔离 |
| 部署 | 单副本 + RWO Volume | 无法滚动升级或弹性伸缩 |

## 3. 设计目标

### 3.1 必须实现

1. 用户能查看自己的当前任务和历史任务。
2. 用户能通过 task ID 查询准确阶段、结果和安全错误信息。
3. 客户端断线或刷新后能恢复任务状态，不依赖浏览器本地缓存。
4. API 和 Worker 可部署多个副本，不重复执行已成功步骤。
5. 同一用户不能占满全局模型资源。
6. 模型、图片和 S3 的瞬时失败可以按明确策略重试。
7. 取消和重试具有明确、幂等、可审计的语义。
8. 兼容现有 `/ideas/generate` 和 `/ideas/:id` 客户端。
9. 每个任务能够关联 HTTP request、Inngest run、Langfuse trace 和生成资产。

### 3.2 暂不实现

- 不做通用 BPMN 或任意 DAG 编辑器；
- 不让用户动态修改 Agent Profile、模型白名单或 Tool 权限；
- 不把 Pi Session 当作任务数据库；
- 不在第一版承诺精确排队位置或完成时间；
- 不用 WebSocket 传输普通任务进度；
- 不把原始 thinking、凭据、图片 base64 或内部 checkpoint 返回给客户端；
- 不在本次设计中实现第二阶段游戏代码生成和 Sandbox。

## 4. 核心边界与状态所有权

### 4.1 PostgreSQL 是业务真相源

客户端只能从 PostgreSQL 投影出的 API 读取任务状态。即使 Inngest Dashboard 显示某个 run 已结束，业务任务也必须在数据库完成最终状态提交后才算完成。

PostgreSQL 负责：

- 谁创建了任务；
- 输入、幂等键和输入哈希；
- 当前状态、阶段和近似进度；
- 用户可见结果和错误；
- checkpoint、重试次数、取消请求；
- 用于 SSE 重放的任务事件；
- Inngest event 的可靠投递记录。

### 4.2 Inngest 是执行真相源

Inngest 只负责“下一步是否应该执行”和“失败步骤何时重试”，不作为客户端直接查询的数据源。

Inngest 负责：

- durable step；
- 成功步骤 memoization；
- 步骤级重试和失败处理；
- 全局、API Client 和用户维度并发；
- 取消事件；
- 后续可能出现的等待用户选择或审批。

步骤返回值必须保持小且可序列化。完整玩法内核和红队收敛结果写入 PostgreSQL checkpoint，Inngest step 只返回 `taskId`、`checkpointVersion`、数量等小型元数据。

### 4.3 Pi 是阶段执行器

Pi Agent 负责读取固定 Profile 和阶段输入，返回结构化结果。Pi Session、turn 和 compaction 都不应成为跨任务恢复的业务依赖。

Pi 负责：

- 模型解析和 Provider 调用；
- Agent Profile、system prompt 和 thinking level；
- 单阶段模型重试与生命周期事件；
- Langfuse 中的 turn、token、cost 和 tool trace。

Pi 不负责：

- HTTP 鉴权；
- 业务幂等；
- 多用户排队；
- 任务列表；
- 取消权限；
- 最终业务状态提交。

### 4.4 为什么选择 Inngest

当前 Idea 任务天然是少量、长耗时、可检查点的固定步骤，且后续可能增加“等待用户选中 Idea”或“等待审批”阶段。需要的是 durable workflow，不是另一个 Agent Runtime。

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 保留 `activeJobs + JsonStore` | 仅用于本地开发 | 不能支持多副本和可靠执行租约 |
| 自研 PostgreSQL polling worker | 不作为首选 | 可以实现，但需要自行补齐 step memoization、重试、取消、并发和运维面板 |
| Inngest + PostgreSQL | 采用 | 与 TypeScript/Express 兼容，职责集中在 durable steps、重试、取消和并发 |
| LangGraph + Pi | 不采用 | 当前 Agent loop 已由 Pi 提供，再增加 graph runtime 会产生重复 Agent 状态和恢复边界 |

Inngest 不能替代业务数据库，Pi 也不能替代 Inngest；三者只有在状态所有权严格区分时组合使用。

## 5. 任务领域模型

### 5.1 状态机

保留现有公开状态，新增 `cancel_requested`：

```text
queued ───────────────► running ───────────────► completed
  │                       │  │                         ▲
  │                       │  └──────────────────────► completed_with_errors
  │                       │
  │                       ├─────────────────────────► failed
  │                       │
  └──► cancel_requested ◄─┘
              │
              └────────────────────────────────────► canceled

failed / completed_with_errors / canceled
              │ retry
              └────────────────────────────────────► queued
```

允许的转换必须由 Domain Service 统一校验，Repository 不能接受任意状态覆盖。

| 当前状态 | 允许的下一状态 |
| --- | --- |
| `queued` | `running`、`cancel_requested`、`canceled`、`failed` |
| `running` | `completed`、`completed_with_errors`、`failed`、`cancel_requested`、`canceled` |
| `cancel_requested` | `canceled`、`failed` |
| `failed` | `queued` |
| `completed_with_errors` | `queued` |
| `canceled` | `queued` |
| `completed` | 终态，不允许原地重跑；复制为新任务 |

`cancel_requested` 不是立即停止承诺。模型或图片 HTTP 请求已经发出时，该原子步骤可以完成，但工作流不得开始下一阶段。

### 5.2 阶段和进度

阶段继续使用当前业务词汇：

| Stage | 用户文案 | 建议进度 |
| --- | --- | ---: |
| `queued` | 等待开始 | 0 |
| `invent` | 正在生成玩法方向 | 10 |
| `converge` | 正在红队筛选并整理最终规格 | 50 |
| `images` | 正在生成效果图 | 75–95 |
| `complete` | 已完成 | 100 |

进度是用户体验提示，不是调度承诺：

- `progress` 必须单调递增；
- 图片阶段按 `completedImages / totalImages` 计算 75–95；
- 重试不得把进度倒退；
- 客户端判断完成必须看 `status`，不能只看 `progress=100`；
- 第一版不返回 ETA 和精确队列位置。

### 5.3 任务身份

- `taskId`：服务生成、不可变，继续使用 `idea_<sortable-id>` 外观以兼容现有客户端；
- `apiClientId`：由服务端根据 `X-API-Key` 解析，调用方不能自行传入；
- `uid`：由调用方显式传入，代表该业务系统内的最终用户；
- `projectId`：业务资源归属；
- `idempotencyKey`：客户端提交动作的稳定标识；
- `inputHash`：规范化输入的 SHA-256；
- `orchestratorRunId`：仅用于内部诊断，不暴露为业务主键。

## 6. PostgreSQL 数据设计

下面是逻辑 DDL；实现时由 migration 工具生成版本化迁移，不在应用启动时自动建表。

以下 SQL 假设 migration 账号先执行 `create schema if not exists ops_assistant`，并为 migration connection 设置 `search_path=ops_assistant,public`。应用运行账号只授予 `ops_assistant` schema 所需的最小权限，不依赖全局 `public` search path。

数据访问选择 `pg`（node-postgres）和显式 SQL，不引入 ORM：

- 统一使用 `DATABASE_URI`，连接串只通过本地 `.env` 或部署 Secret 注入，禁止写入代码、示例文件或文档；
- 连接格式只在文档中使用脱敏模板：`postgres://<user>:<password>@<rds-host>:5432/loopit_lab?sslmode=no-verify`；
- 复用 `loopit_lab` 数据库时，业务表放在独立 `ops_assistant` schema，避免与 Payload `public` schema 和其他服务表混用；
- 每个进程只创建一个有上限的 `Pool`；
- 普通单条查询可以使用 `pool.query`；
- 事务必须从 Pool 领取同一个 client，并在该 client 上完成 `BEGIN/COMMIT/ROLLBACK`；
- 所有外部值使用参数化查询，禁止字符串拼接 SQL；
- JSONB 从数据库读出后继续用现有 Zod schema 校验；
- migration 使用仓库内版本化 SQL，由部署 Job 执行；
- Pool 大小、连接超时和 statement timeout 由环境配置，并纳入指标。

这些约定沿用 `loopit-lab/src/payload.config.ts` 和 readiness 实现的做法：应用启动不执行自动 schema push；部署先运行独立 migration Job；readiness 同时检查数据库可达性和已应用 migration ledger 是否与当前版本兼容，并设置连接、查询和总 deadline。关闭进程时先停止接收任务，再释放 client 并执行 `pool.end()`，不能依赖强制 `process.exit()`。

QA 初期可以复用现有 RDS 实例和数据库，但运行时账号最终应收敛为仅能访问 `ops_assistant` schema 的最小权限账号；migration 账号和应用运行账号应分离。

### 6.1 `agent_tasks`

```sql
create table agent_tasks (
  id                       text primary key,
  task_type                text not null,
  api_client_id            text not null,
  uid                      text not null,
  project_id               text,

  status                   text not null,
  stage                    text not null,
  progress                 smallint not null default 0,
  status_message           text,

  idempotency_key          varchar(128) not null,
  input_hash               char(64) not null,
  input                    jsonb not null,
  result_summary           jsonb,

  workflow_version         text not null,
  prompt_version           text not null,
  model_ids                jsonb not null,
  execution_engine         text not null,
  orchestrator_run_id      text,
  attempt                  integer not null default 0,
  row_version              integer not null default 0,

  error_code               text,
  error_message            text,
  cancel_requested_at      timestamptz,
  queued_at                timestamptz not null default now(),
  started_at               timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint agent_tasks_progress_check check (progress between 0 and 100),
  constraint agent_tasks_status_check check (status in (
    'queued', 'running', 'cancel_requested', 'completed',
    'completed_with_errors', 'failed', 'canceled'
  )),
  constraint agent_tasks_engine_check check (execution_engine in ('local', 'inngest')),
  constraint agent_tasks_identity_unique unique (
    api_client_id, uid, task_type, idempotency_key
  )
);

create index agent_tasks_owner_created_idx
  on agent_tasks (api_client_id, uid, created_at desc, id desc);

create index agent_tasks_active_idx
  on agent_tasks (status, queued_at)
  where status in ('queued', 'running', 'cancel_requested');
```

数据库唯一约束是永久业务幂等边界。不能只依赖 Inngest event ID，因为其事件去重窗口不是永久业务约束。

### 6.2 `agent_task_checkpoints`

```sql
create table agent_task_checkpoints (
  task_id             text not null references agent_tasks(id) on delete cascade,
  stage               text not null,
  schema_version      text not null,
  model_id            text,
  prompt_hash         char(64),
  payload             jsonb not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (task_id, stage)
);
```

V1 阶段值第一版为 `invention`、`convergence`。每个步骤通过 UPSERT 幂等写入；已通过 schema 校验的 checkpoint 才能保存。切换前的 V2 历史数据可以保留 `audits` checkpoint，但新任务不再写入。

### 6.3 `idea_task_results`

```sql
create table idea_task_results (
  task_id             text not null references agent_tasks(id) on delete cascade,
  idea_id             text not null,
  ordinal             integer not null,
  payload             jsonb not null,
  image_status        text not null,
  image_url           text,
  image_model         text,
  image_storage       text,
  image_error_code    text,
  image_error_message text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (task_id, idea_id),
  unique (task_id, ordinal)
);
```

图片对象使用确定性 Key；普通 retry 复用已经成功的对象，只为失败或缺失的图片写入目标 Key，避免生成重复资产记录。

Idea 图片不进入正式游戏发布使用的 `public/game`。该内部服务在 development 和 production 中默认都写入：

```text
s3://leap-workspace-shared-dev/lab/ideas/{taskId}/{ideaId}.png
https://cdn-cf-dev.loopit.me/lab/ideas/{taskId}/{ideaId}.png
```

对应配置为 `IDEA_ASSET_BUCKET=leap-workspace-shared-dev`、`IDEA_ASSET_PREFIX=lab/ideas` 和 `IDEA_ASSET_CDN_BASE_URL=https://cdn-cf-dev.loopit.me`。user/project 只写入 S3 Object Metadata。成功图片在普通 retry 中直接复用，不覆盖带 `immutable` 缓存的对象；需要使用新 Profile、Prompt 或模型重新生成时创建新 task，从而获得新的对象目录。

### 6.4 `agent_task_events`

```sql
create table agent_task_events (
  id              bigserial primary key,
  task_id         text not null references agent_tasks(id) on delete cascade,
  event_type      text not null,
  status          text,
  stage           text,
  progress        smallint,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index agent_task_events_task_id_idx
  on agent_task_events (task_id, id);
```

状态修改和事件插入必须处于同一数据库事务。SSE 使用 `id` 作为 `Last-Event-ID`，客户端断线后可以补发遗漏事件。

### 6.5 `agent_task_outbox`

```sql
create table agent_task_outbox (
  id              bigserial primary key,
  aggregate_id    text not null,
  event_id        text not null unique,
  event_name      text not null,
  payload         jsonb not null,
  available_at    timestamptz not null default now(),
  published_at    timestamptz,
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now()
);

create index agent_task_outbox_pending_idx
  on agent_task_outbox (available_at, id)
  where published_at is null;
```

创建任务与写入 `idea/task.requested` outbox 必须同事务提交。Dispatcher 使用 `FOR UPDATE SKIP LOCKED` 领取记录，成功发送 Inngest event 后标记 `published_at`。这样 API 成功返回后即使进程退出，也不会留下永远无法执行的 `queued` 任务。

## 7. Business API

### 7.1 版本和资源命名

新增规范接口：

```text
POST /v1/idea-tasks
GET  /v1/idea-tasks
GET  /v1/idea-tasks/:taskId
GET  /v1/idea-tasks/:taskId/events
POST /v1/idea-tasks/:taskId/cancel
POST /v1/idea-tasks/:taskId/retry
```

保留兼容接口：

```text
POST /ideas/generate       → POST /v1/idea-tasks
GET  /ideas/:id            → GET /v1/idea-tasks/:taskId
```

兼容接口在迁移期接受 `userId` 并规范化为 `uid`；新接口只使用 `uid`。如果请求同时提供两者且值不同，返回 `400 VALIDATION_FAILED`。API Key 只识别调用系统，不替代最终用户信息。

### 7.2 创建任务

```http
POST /v1/idea-tasks
X-API-Key: <service-api-key>
Idempotency-Key: project-123-submit-001
Content-Type: application/json
```

```json
{
  "uid": "user-123",
  "projectId": "project-123",
  "theme": "会移动的微型花园",
  "audience": "休闲游戏用户",
  "emotion": "治愈、紧张、满足",
  "duration": "单局 30 秒",
  "notes": "单手操作，前三秒看懂",
  "forbidden": "品牌 Logo 和受版权保护素材",
  "count": 2
}
```

返回 `202 Accepted`：

```json
{
  "task": {
    "id": "idea_01K...",
    "type": "idea.generate",
    "projectId": "project-123",
    "status": "queued",
    "stage": "queued",
    "progress": 0,
    "statusMessage": "等待开始",
    "createdAt": "2026-07-17T08:00:00.000Z",
    "updatedAt": "2026-07-17T08:00:00.000Z",
    "links": {
      "self": "/v1/idea-tasks/idea_01K...",
      "events": "/v1/idea-tasks/idea_01K.../events"
    }
  },
  "idempotentReplay": false
}
```

幂等语义：

- 同一 `apiClientId + uid`、相同 Key、相同规范化输入：返回原 task；
- 同一 `apiClientId + uid`、相同 Key、不同输入：`409 IDEMPOTENCY_KEY_REUSED`；
- 不同 API Client 或不同 `uid` 可以使用相同 Key；
- API 超时后客户端必须使用原 Key 重试；
- 数据库唯一约束解决并发双击，不依赖先查后写。

### 7.3 用户任务列表

```http
GET /v1/idea-tasks?uid=user-123&status=running,completed&limit=20&cursor=<opaque>
X-API-Key: <service-api-key>
```

```json
{
  "items": [
    {
      "id": "idea_01K...",
      "projectId": "project-123",
      "theme": "会移动的微型花园",
      "status": "running",
      "stage": "images",
      "progress": 84,
      "statusMessage": "正在生成效果图 1/2",
      "ideaCount": 2,
      "createdAt": "2026-07-17T08:00:00.000Z",
      "updatedAt": "2026-07-17T08:03:00.000Z"
    }
  ],
  "nextCursor": "opaque-or-null"
}
```

要求：

- 强制按服务端解析出的 `apiClientId + uid` 过滤；
- 使用 `(created_at, id)` keyset pagination，不使用大 offset；
- 默认不返回完整 Idea 和 checkpoint；
- 支持 `status`、`projectId` 和时间范围过滤；
- `limit` 默认 20，最大 100。

### 7.4 查询任务详情

```http
GET /v1/idea-tasks/:taskId?uid=user-123
X-API-Key: <service-api-key>
```

只有终态返回完整 `ideas`。运行中可返回已经完成的图片数量，但不返回发明和红队收敛 checkpoint，避免泄漏内部推理材料和不稳定中间结果。

不存在和不属于当前用户都返回 `404 TASK_NOT_FOUND`，不泄漏 task ID 是否存在。

### 7.5 取消

```http
POST /v1/idea-tasks/:taskId/cancel?uid=user-123
X-API-Key: <service-api-key>
```

语义：

1. 数据库事务将状态改为 `cancel_requested`；
2. 同事务写入 `idea/task.cancel.requested` outbox；
3. Inngest 通过匹配 `taskId` 的取消事件停止后续步骤；
4. 当前原子步骤允许结束，完成清理后写入 `canceled`；
5. 重复取消返回当前任务，保持幂等；
6. 对终态任务取消返回 `409 TASK_NOT_CANCELABLE`。

### 7.6 重试

```http
POST /v1/idea-tasks/:taskId/retry?uid=user-123
X-API-Key: <service-api-key>
Idempotency-Key: retry-001
```

允许从 `failed`、`completed_with_errors`、`canceled` 重试：

- task ID 保持不变；
- `attempt + 1`；
- schema、prompt hash 和模型一致的成功 checkpoint 可以复用；
- 失败图片恢复为 `pending`，成功图片不重复生成；
- retry 继续使用任务记录的原 Profile、Prompt 和模型版本；旧版本已不可用时返回 `409 TASK_NOT_RETRYABLE`；
- 用户要求“使用最新配置重新生成”时创建新任务，而不是 retry，避免覆盖原任务的 immutable 图片对象。

### 7.7 SSE 进度

```http
GET /v1/idea-tasks/:taskId/events?uid=user-123
X-API-Key: <service-api-key>
Accept: text/event-stream
Last-Event-ID: 12345
```

事件示例：

```text
id: 12346
event: task.stage.changed
data: {"taskId":"idea_01K...","status":"running","stage":"converge","progress":50}

id: 12347
event: idea.image.completed
data: {"taskId":"idea_01K...","ideaId":"k01","completed":1,"total":2,"progress":85}

id: 12348
event: task.completed
data: {"taskId":"idea_01K...","status":"completed","stage":"complete","progress":100}
```

事件类型：

- `task.snapshot`；
- `task.status.changed`；
- `task.stage.changed`；
- `idea.image.completed`；
- `idea.image.failed`；
- `task.completed`；
- `task.failed`；
- `task.canceled`；
- `heartbeat`。

SSE 是体验增强，任务详情 API 才是最终事实。客户端必须在 SSE 断开时退化为 2–3 秒轮询。

浏览器原生 `EventSource` 不能附加 `X-API-Key`。Web 客户端应选择以下一种方式：

1. 使用支持流式读取的 `fetch()` 发起带 `X-API-Key` 的 SSE 请求；
2. 先通过已认证接口换取只绑定当前 task、短时有效、一次用途的 subscription token；
3. 由可信后端订阅 SSE，再转发给其前端。

禁止把长期 API Key、Inngest Key 或内部 Signing Key 放在 URL query 中。

### 7.8 错误协议

统一错误结构：

```json
{
  "error": {
    "code": "USER_ACTIVE_TASK_LIMIT",
    "message": "当前已有 2 个任务正在运行",
    "requestId": "req_01K..."
  }
}
```

内部 Provider 错误、SQL、堆栈和凭据不得进入 `message`。详细错误进入结构化日志、Langfuse 或内部任务事件。

| HTTP | Code | 场景 |
| ---: | --- | --- |
| 400 | `VALIDATION_FAILED` | 请求字段、幂等键格式或 cursor 无效 |
| 401 | `AUTHENTICATION_REQUIRED` | API Key 缺失、无效、禁用或过期 |
| 403 | `AUTHORIZATION_DENIED` | 已认证但缺少管理权限；普通任务越权查询仍返回 404 |
| 404 | `TASK_NOT_FOUND` | 任务不存在或不属于当前用户 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一个 Key 对应不同输入 |
| 409 | `TASK_NOT_CANCELABLE` | 终态任务取消 |
| 409 | `TASK_NOT_RETRYABLE` | 当前状态不允许重试 |
| 429 | `USER_ACTIVE_TASK_LIMIT` | 用户活跃任务达到上限 |
| 429 | `USER_TASK_QUOTA_EXCEEDED` | 用户或 API Client 周期额度耗尽 |
| 503 | `TASK_SERVICE_UNAVAILABLE` | 数据库或任务子系统在事务提交前不可用 |

任务和 outbox 已成功提交后，即使 Inngest 暂时不可达也应返回 `202`，由 Dispatcher 后续重试投递，不能把一个已经存在的 task 伪装成提交失败。

## 8. 提交事务与并发控制

### 8.1 创建事务

创建任务必须在一个数据库事务内完成：

1. 验证 API Key 得到 `apiClientId`，并校验请求中的 `uid`；
2. 规范化输入并计算 `inputHash`；
3. 对当前用户取得事务级 advisory lock，或使用等价的串行化边界；
4. 查询是否已有相同幂等记录；
5. 统计当前用户活跃任务，默认上限为 2；
6. 插入 `agent_tasks`；
7. 插入第一条 `agent_task_events`；
8. 插入 `agent_task_outbox`；
9. 提交事务；
10. 返回 `202`。

单纯执行“先 count、再 insert”会在并发请求下突破上限，必须有数据库级串行化边界。

### 8.2 初始并发策略

建议初始值：

| 资源 | 限制 |
| --- | ---: |
| 每用户活跃 Idea 任务 | 2 |
| 每 API Client 活跃 Idea 任务 | 10 |
| 全局 Idea Workflow 执行步骤 | 8 |
| 全局文本模型调用 | 6 |
| 全局图片模型调用 | 4 |
| 单任务图片并发 | 2 |

这些值必须由配置和压测结果决定，不能散落在 Prompt 或路由中。队列公平性至少按 `apiClientId` 和 `uid` key 限制，避免一个调用系统或用户占满全局容量。

并发限制解决“同时执行多少”，额度解决“一个周期允许消费多少”。任务提交前还应预留以下扩展点：

- 每用户每日创建任务数；
- 每 API Client 每日文本 token 或成本预算；
- 每任务最大 Idea 数和图片数；
- 管理员可审计的额度调整记录；
- 超额时返回明确 `429 + Retry-After`，不能让 Agent 自己判断是否有额度。

## 9. Inngest Workflow

### 9.1 事件

```text
idea/task.requested
idea/task.cancel.requested
idea/task.retry.requested
```

事件 payload 只携带定位信息：

```json
{
  "taskId": "idea_01K...",
  "apiClientId": "loopit-lab",
  "uid": "user-1",
  "attempt": 1
}
```

不要把完整用户输入、模型结果或凭据发送到事件系统。Worker 每一步按 task ID 从 PostgreSQL 读取最新业务数据。

### 9.2 步骤划分

```text
claim-task
  → invent
  → converge
  → persist-pending-results
  → image:<ideaId> × N
  → finalize-task
```

实现原则：

- 每个阶段是独立 `step.run()`；
- 步骤开始前检查数据库状态和 `cancel_requested_at`；
- 步骤成功后在一个数据库事务中写 checkpoint、更新 task、写 task event；
- checkpoint 已存在且版本匹配时直接复用；
- 图片步骤使用稳定 `ideaId` 构造 step ID；
- 图片和 S3 Key 必须可幂等重试；
- 完成状态由数据库中所有 `idea_task_results.image_status` 计算；
- 任意图片失败不抹掉文本结果，任务进入 `completed_with_errors`；
- 发明或红队收敛失败使任务进入 `failed`。

伪代码：

```ts
const generateIdeas = inngest.createFunction(
  {
    id: "idea-generate-v1",
    retries: 2,
    // 实现时按锁定的 Inngest SDK 版本填写 concurrency/cancelOn 配置。
  },
  { event: "idea/task.requested" },
  async ({ event, step }) => {
    const { taskId } = event.data;

    await step.run("claim-task", () => taskService.claim(taskId));
    await step.run("invent", () => ideaStages.invent(taskId));
    const ideas = await step.run("converge", () => ideaStages.converge(taskId));

    await Promise.all(
      ideas.map(({ ideaId }) =>
        step.run(`image:${ideaId}`, () => imageStages.generate(taskId, ideaId)),
      ),
    );

    return step.run("finalize-task", () => taskService.finalize(taskId));
  },
);
```

代码示例是结构约束，不是直接复制的 SDK 锁版本代码。引入依赖时必须锁定 Inngest major version，并按对应官方文档确认 Express handler、trigger 和并发配置。

### 9.3 重试预算

必须避免 Pi、业务 Workflow 和 Inngest 三层无限相乘：

- Pi/Provider 层：只处理单次调用内部的短暂网络、429 和 5xx；
- Inngest step：处理进程退出、调用超时和可恢复基础设施失败；
- 业务 retry API：由用户明确发起新的 attempt；
- schema 不合法、权限错误、配置错误标记为 non-retriable；
- 每次重试都记录 `attempt`、error code 和 provider request ID；
- S3 和数据库写入必须先实现幂等，再允许自动重试。

## 10. 鉴权与多租户隔离

1. 生产环境所有 `/v1/*` 接口必须验证 `X-API-Key`。
2. API Key 只标识受信调用系统，服务端解析出稳定的 `apiClientId`，不能接受调用方自行声明该值。
3. `uid` 由调用系统显式传入；它不是认证凭据，不能脱离 `apiClientId` 单独作为授权边界。
4. Repository 的每个读取和修改方法都要求 `TaskScope { apiClientId, uid }`。
5. 不属于当前 scope 的 task 与不存在统一返回 404。
6. 管理员查询使用独立 scope，例如 `idea:tasks:read:any`，不得复用普通用户接口中的布尔参数。
7. SSE token 只能订阅一个已经完成授权检查的 task。
8. 内部 Inngest handler 使用 Signing Key 校验，不暴露给普通客户端。
9. 调用方 API Key、模型 Key、Inngest Event Key、Signing Key、数据库凭据和 Langfuse Key 只通过 Secret 注入。
10. 日志和 task event 继续复用现有 sanitize/redaction 规则。

MVP 不额外建设 API Key 管理后台。使用 Secret 注入 `API_KEYS_JSON`，内容是 `apiClientId → key` 的映射；启动时校验格式，认证时使用 timing-safe comparison。配置、日志、错误响应和 trace 都不得输出完整 Key。第一版需要轮换时同时配置新旧两个 Key，调用方迁移完成后删除旧 Key。

当调用方数量、权限或轮换频率增长后，再迁移到 `api_clients` 表：数据库只保存 Key hash、可识别前缀、scope、启停状态和过期时间，不保存可还原的完整 Key。该升级不改变请求协议和 `TaskScope`。

### 10.1 路由权限域

当前代码仍使用 JWT authentication；Phase 0 将 Idea 业务接口切换为 API Key + `uid`。其他运营与管理员路由不应因此自动开放，正式上线前必须重新分组：

| 权限域 | 路由示例 | 要求 |
| --- | --- | --- |
| Public | `/health` | 无用户数据 |
| Business caller | `/v1/idea-tasks/*` | API Key + `apiClientId + uid` 行级隔离 |
| Admin | `/admin/config/*`、`/admin/skills/*`、`/admin/schedules/*` | 独立管理员认证，不复用普通调用方 API Key |
| Internal | `/api/inngest`、手动 scheduler tick、outbox 运维 | Signing Key、内网或服务身份 |

具体要求：

- 生产环境禁用或移除通用 `/state`，不得向普通用户返回全局消息、调度和 outbox；
- `/im/messages`、`/im/stream` 等旧接口是否迁移到 API Key 必须单独设计，不能因为 Idea API 改造而隐式放开；
- 配置写入、Skill 管理、Segment 和 Scheduled Task 管理迁移到 `/admin/*`；
- 不能使用前端传入的 `isAdmin=true`，管理员权限必须来自受信 token claim；
- Worker 的 `/api/inngest` 必须能被 Inngest 服务访问，但只接受签名请求，不挂载普通业务 Router。

## 11. 代码结构

建议渐进调整为：

```text
src/
├── agent/                         # Pi runtime，不承担任务管理
├── ideas/
│   ├── contracts.ts               # Idea 输入输出 schema
│   ├── stages.ts                  # V1 invent/converge 纯阶段服务
│   ├── image-pipeline.ts
│   └── local-workflow.ts          # 迁移期保留
├── tasks/
│   ├── domain.ts                  # Task 状态、转换和错误码
│   ├── service.ts                 # submit/list/get/cancel/retry
│   ├── repository.ts              # TaskRepository interface
│   └── events.ts                  # 用户可见 task events
├── orchestration/
│   └── inngest/
│       ├── client.ts
│       ├── events.ts
│       ├── idea-workflow.ts
│       ├── failure-handler.ts
│       └── router.ts              # /api/inngest
├── infrastructure/
│   ├── postgres/
│   │   ├── task-repository.ts
│   │   ├── migrations/
│   │   └── pool.ts
│   └── outbox/
│       └── dispatcher.ts
└── http/
    ├── idea-task-router.ts
    ├── task-events.ts
    └── error-response.ts
```

`TaskRepository` 只暴露业务操作，不向上泄漏 SQL：

```ts
interface TaskRepository {
  submitIdeaTask(scope: TaskScope, input: IdeaTaskInput, key: string): Promise<SubmitResult>;
  listIdeaTasks(scope: TaskScope, query: TaskListQuery): Promise<TaskPage>;
  getIdeaTask(scope: TaskScope, taskId: string): Promise<IdeaTask | undefined>;
  transition(taskId: string, expected: TaskStatus[], next: TaskTransition): Promise<IdeaTask>;
  putCheckpoint(taskId: string, checkpoint: TaskCheckpoint): Promise<void>;
  appendEvent(taskId: string, event: TaskEvent): Promise<void>;
}
```

HTTP Router 不直接调用 Pi，也不直接操作数据库；Inngest Function 不解析外部 API Key，也不拼接客户端响应。

## 12. 实时更新选择

第一版选择“数据库事件表 + Express SSE”：

- 与前端框架无关；
- 能使用 `Last-Event-ID` 做持久重放；
- 任务列表和详情仍来自同一数据库；
- Inngest 暂时不可用时不影响用户读取已经提交的任务。

Inngest Realtime 可以作为后续低延迟通道，但不能替代 PostgreSQL 中的 task event，因为实时消息本身不是业务历史和审计记录。若引入，必须由后端签发只允许订阅当前 task channel 的 token。

### 12.1 多副本 SSE Broker

第一版不为每条 SSE 连接持续轮询数据库，也不能只在写入任务的 Pod 内存中广播。建议：

1. 状态事务插入 `agent_task_events`；
2. 同一事务执行 `pg_notify('agent_task_events', '<taskId>:<lastEventId>')`；
3. 每个 API Pod 只维护一个专用 PostgreSQL `LISTEN` connection；
4. Pod 内按 task ID 管理已经授权的 SSE subscriber；
5. 收到通知后查询 `id > subscriber.lastEventId` 的持久事件并发送；
6. 每 15 秒发送 heartbeat，并周期性执行 catch-up，弥补网络抖动或通知丢失；
7. 客户端重连时使用 `Last-Event-ID` 从事件表补发。

`NOTIFY` payload 只传 task ID 和最后事件 ID，不传用户输入或结果正文。数据库连接池之外应保留一个专用 LISTEN connection，并在进程关闭时释放。

## 13. 可观测性

### 13.1 关联 ID

每条日志和 trace 至少携带：

- `requestId`；
- `taskId`；
- `apiClientId`；
- `uid` 的不可逆哈希或内部 ID；
- `orchestratorRunId`；
- `langfuseTraceId`；
- `stage`；
- `attempt`。

### 13.2 指标

最低指标集：

- task submit rate；
- queue wait duration；
- total task duration；
- 每阶段 duration；
- completed / completed_with_errors / failed / canceled 比例；
- retry count 和 error code 分布；
- 当前活跃任务数，按全局、API Client 和用户维度；
- LLM token、cost、timeout、429；
- 图片成功率和生成时延；
- SSE 当前连接数和重连次数；
- outbox backlog age。

Langfuse 继续保存 Agent/turn/tool 级观测；业务任务表只保存必要关联 ID 和聚合指标，不复制完整模型 trace。

## 14. 部署拓扑

### 14.1 迁移初期

```text
one application deployment
  ├─ Express API
  ├─ Inngest handler
  └─ outbox dispatcher

shared PostgreSQL
Inngest Dev Server / managed environment
```

先保持一副本，验证数据库和 durable workflow 语义，不在第一次迁移中同时引入 HPA。

### 14.2 稳定后

```text
API Deployment × N
  └─ business API / SSE

Worker Deployment × N
  └─ /api/inngest + Pi + model credentials

Dispatcher Deployment × 1..N
  └─ SKIP LOCKED outbox publishing

PostgreSQL + Inngest + S3/CDN
```

API Pod 不需要模型和图片 API Key；Worker Pod 不需要对公网暴露普通业务路由。完成 PostgreSQL 和外部编排迁移后，才能移除当前 Deployment 的 `Recreate + replicas: 1` 限制。

## 15. 数据保留与清理

建议默认策略，最终由产品和合规要求确认：

| 数据 | 默认保留 |
| --- | --- |
| task 主记录和最终 Idea | 180 天 |
| task events | 终态后 30 天 |
| invention/convergence checkpoint | 终态后 30 天 |
| 安全错误摘要 | 与 task 主记录一致 |
| Langfuse trace | 使用现有观测平台策略 |
| S3/CDN Idea 图片 | 默认与 task 主记录一致，为 180 天；仍被业务引用时不得提前删除 |

清理任务必须使用分页和小批量删除；先删 checkpoint/event，再按业务策略匿名化或删除 task。`lab/ideas/{taskId}/` 可由 S3 Lifecycle 或清理任务回收，但删除数据库记录不能隐式删除仍被业务引用的图片。

## 16. 迁移计划

### Phase 0：补齐当前 MVP API

不改变执行引擎，先完成：

- `GET /v1/idea-tasks`；
- cancel/retry HTTP 路由；
- 统一错误码；
- 增加 `X-API-Key` middleware 和 `API_KEYS_JSON` Secret 配置；
- 新接口显式接收 `uid`，Repository 始终按 `apiClientId + uid` 查询；
- 前端保存 task ID 并支持轮询恢复。

验收：单实例下多个用户能够看到各自历史、取消和重试，不能越权查询。

### Phase 1：Repository 抽象和 PostgreSQL

- 引入 `TaskRepository`；
- 实现 PostgreSQL schema 和 Repository；
- Idea Workflow 改为只依赖 Repository interface；
- 编写一次性 `state.json → PostgreSQL` 导入工具；
- 仍使用本地执行器，保持单副本。

验收：现有 API contract 和 Idea 结果不变；并发提交测试不会突破单用户上限；重启后从数据库恢复。

### Phase 2：Inngest durable workflow

- 引入 Inngest client、Express handler 和事件 schema；
- 增加 outbox dispatcher；
- 将 V1 的 invent/converge/images 拆为 durable steps；
- 增加取消事件和 failure handler；
- 使用 `IDEA_WORKFLOW_ENGINE=local|inngest` 做切换；
- 切换前停止接收新任务并排空本地 `queued/running` 任务，禁止同一 task 双执行。

这是对 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) 中“durable scheduler/queue 延后”和精简依赖策略的有意演进。Phase 2 合并时必须同步更新架构与部署文档，明确 Inngest 是 Workflow 基础设施而不是第二个 Agent Framework。

验收：在 invent、converge、images 阶段分别 kill Worker，恢复后不重复已成功步骤；图片和 S3 无重复副作用。

### Phase 3：SSE 与多副本

- 写入 task event；
- 实现 SSE replay 和 polling fallback；
- 分离 API 与 Worker Deployment；
- 开启多副本和并发限制；
- 更新 Kubernetes、告警和容量基线。

验收：客户端断线重连能恢复事件；两个 API 副本并发提交仍满足幂等和容量限制；滚动升级不丢任务。

### Phase 4：通用业务任务能力

当第二种长耗时 Agent 业务出现后，再抽取通用 `agent_tasks` API 和 UI。不要为了假想需求提前把所有普通 CRUD 都包装成 Agent Task。

## 17. 测试计划

### 17.1 单元测试

- 状态转换表；
- 输入规范化和 hash；
- error code 映射；
- checkpoint 版本复用；
- progress 单调性；
- 用户 scope 过滤。

### 17.2 PostgreSQL 集成测试

- 三个并发请求提交给同一用户时最多创建两个活跃任务；
- 同一幂等键并发提交只产生一条 task 和一条 requested outbox；
- 不同用户相同幂等键互不影响；
- 状态和 task event 同事务提交；
- Dispatcher 多副本不会重复领取同一 outbox；
- cursor pagination 无重复和遗漏。

### 17.3 Workflow 测试

- 已有 checkpoint 时不重复调用 Agent；
- schema 错误进入 non-retriable failed；
- 429/timeout 按预算重试；
- 一张图片失败得到 `completed_with_errors`；
- cancel 在步骤边界生效；
- retry 只重跑失败图片；
- prompt/version 变化后不错误复用旧 checkpoint。

### 17.4 端到端和故障测试

- 提交、列表、详情、SSE、完成结果完整闭环；
- 跨用户读取返回 404；
- API 返回 202 后立即 kill API，outbox 仍能投递；
- 每个阶段 kill Worker 并验证恢复；
- 数据库短暂不可用、Inngest 短暂不可用、模型 429、S3 5xx；
- 多副本滚动发布期间不丢失或重复执行任务；
- 真实模型受控 smoke case 验证 Langfuse、CDN 和最终 API。

## 18. 发布与回滚

- 数据库 migration 必须向前兼容至少一个应用版本；
- 先发布只读新字段，再发布写入，再切换读取，最后删除旧字段；
- 切换 Inngest 前必须排空本地活跃任务；
- `IDEA_WORKFLOW_ENGINE` 只决定新任务的执行器，已创建任务记录自己的 `execution_engine`；
- 回滚时不得让 local 和 Inngest 同时领取同一个 task；
- 所有自动副作用使用稳定 task/step key，确保 replay 安全；
- 生产切换前保留 `state.json` 只读备份，验证导入数量、终态数量和图片 URL 数量。

## 19. 验收标准

设计完成实现后，应满足：

1. 用户登录后无需本地保存 ID，也能看到自己的全部 Idea 任务。
2. 用户只能读取、取消和重试自己的任务。
3. API 返回 202 后任意单进程退出都不会丢任务。
4. 已成功的 Agent 阶段不会因为 Worker 重启而再次收费执行。
5. 单用户、API Client 和全局并发限制都可配置、可观测。
6. 客户端可以轮询，也可以通过 SSE 获得可重放的状态事件。
7. `completed_with_errors` 保留可用文本和成功图片。
8. 多副本部署不需要共享本地 JSON 文件或 RWO Volume。
9. Langfuse trace、Inngest run、业务 task 和 S3 资产可以互相定位。
10. 现有 `/ideas/generate` 和 `/ideas/:id` 客户端在迁移窗口内继续工作。

## 20. 参考资料

- [Inngest durable execution](https://www.inngest.com/docs/learn/how-functions-are-executed)
- [Inngest `step.run()` and step retries](https://www.inngest.com/docs/reference/typescript/v4/functions/step-run)
- [Inngest concurrency controls](https://www.inngest.com/docs/guides/concurrency)
- [Inngest idempotency](https://www.inngest.com/docs/guides/handling-idempotency)
- [Inngest cancellation with `cancelOn`](https://www.inngest.com/docs/reference/typescript/functions/cancel-on)
- [Inngest Express-compatible `serve()` handler](https://www.inngest.com/docs/reference/typescript/v4/serve)
- [Inngest Realtime](https://www.inngest.com/docs/features/realtime)
- [node-postgres pooling](https://node-postgres.com/features/pooling)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- 当前部署边界：[`docs/DEPLOYMENT.md`](DEPLOYMENT.md)
- 当前 Idea API：[`docs/idea-api.md`](idea-api.md)
