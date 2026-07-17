# Loopit 创作者运营 Agent

面向创作者运营场景的 Agent 服务：通过 IM 生成个性化触达内容，按需读取运营知识和远程业务 Skill，并通过 MCP 查询创作者、作品和活动数据。

## 当前能力

- Gemini / Vertex 模型调用，支持 Profile 级模型、参数、提示词和工具白名单。
- `/im/messages` 一次性返回 JSON。
- `/im/stream` 以 SSE 流式返回文本、工具调用、用量和最终结果。
- 对话按 `userId + imThreadId` 持久化，可继续已有 Session。
- 默认 Skill 按 Pi 规范使用 `<name>/SKILL.md`，会话启动时注册到 system prompt，由内置 `read` 工具按需加载。
- 远程业务 Skill 从 S3 物料化到会话目录，同样由 Pi 内置 `read` 工具只读加载。
- 默认 Skill 及其 `docs/` 参考资料通过 Pi 内置 `read` 工具读取。
- Loopit 业务数据通过 Streamable HTTP MCP 访问，不在本项目内实现数据查询逻辑。
- 可选 Langfuse trace，记录模型、工具、Token 和费用信息。

## 快速启动

要求 Node.js 22.19+、pnpm 10+。

```bash
corepack enable
pnpm install
pnpm dev
```

配置方式与 Carmack 一致：`.env` 是公共基线，测试使用 `.env + .env.test`，生产使用 `.env + .env.production`，后加载的环境文件覆盖同名配置。测试或容器启动时需要同时传入基础文件和对应环境覆盖文件。

打开 <http://localhost:8010/> 可使用本地调试页面。

只验证本地链路时：

```bash
ASSISTANT_DRY_RUN=true pnpm dev:once
```

真实调用 Gemini 需要配置 `GOOGLE_APPLICATION_CREDENTIALS` 和 `GOOGLE_CLOUD_PROJECT`。生产环境还需要配置 JWT、MCP 和必要的 Langfuse 参数。

## 常用接口

流式对话：

```bash
curl -N -X POST http://localhost:8010/im/stream \
  -H 'content-type: application/json' \
  -d '{"userId":"u1","imThreadId":"t1","text":"帮我写一条春日创作挑战邀请"}'
```

一次性对话：

```bash
curl -X POST http://localhost:8010/im/messages \
  -H 'content-type: application/json' \
  -d '{"userId":"u1","imThreadId":"t1","text":"帮我写一条活动邀请","reply":true}'
```

其他入口：

- `GET /health`：健康检查。
- `GET /im/messages`：读取会话消息。
- `POST /data/query`：读取本地样例数据，仅用于离线调试。
- `POST /schedules`、`POST /scheduler/tick`：创建和执行主动触达任务。
- `GET /outbox`：查看待发送的触达消息。

## Profile 与 Skill

Profile 定义在 [`src/agent/profiles/`](src/agent/profiles/)；对应系统提示词在 [`config/agent-profiles/`](config/agent-profiles/)。

## Idea 发散 Workflow

`POST /ideas/generate` 使用三个互相隔离的 Pi Agent Profile，依次执行玩法发明、独立审计和规格化收敛；最终由服务端为每个入选 Idea 生成一张竖屏概念图。一次请求最多返回 8 个方向。接口要求携带 8–128 字符的 `Idempotency-Key`，创建成功后立即返回 `202`，客户端通过查询接口读取进度。

```http
POST /ideas/generate
Idempotency-Key: u-1-project-1-submit-001
```

```json
{
  "userId": "u-1",
  "projectId": "project-1",
  "theme": "会移动的花园",
  "audience": "休闲游戏用户",
  "emotion": "轻松但需要快速判断",
  "duration": "30 秒",
  "notes": "优先单手操作",
  "count": 4
}
```

平台不作为 API 入参，workflow 内固定为 `Loopit 竖屏 Feed`。

相同用户、相同幂等键和相同入参会返回原任务；相同幂等键换入参返回 `409`。每个 Agent 阶段都保存 checkpoint，进程启动时会恢复 `queued/running` 任务。响应中的每个 `idea` 同时包含玩法文本字段和 `image.url`。

- `GET /ideas/:id?userId=<userId>`：查询状态和结果。Idea 对外只提供提交和查询两个路由。

JWT 模式下，token 的 `sub` 必须与 `userId` 一致。

图片生成优先读取 `IDEA_IMAGE_BASE_URL`、`IDEA_IMAGE_API_KEY`、`IDEA_IMAGE_MODEL`，也兼容现有的 `AZURE_IMAGE_BASE_URL`、`AZURE_IMAGE_API_KEY`、`AZURE_IMAGE_DEPLOYMENT`。未配置图片服务时文本结果仍会保存，workflow 状态为 `completed_with_errors`。

本地开发默认把图片保存在 `DATA_DIR/idea-images/`。生产环境设置 `IDEA_ASSET_STORAGE=s3` 后，图片上传到 Carmack 同款 public-image bucket，并返回 `https://cdn-cf.loopit.me/public/ideas/...`；非生产 S3 环境使用 `https://cdn-cf-dev.loopit.me`。对象使用不可变缓存头，并按 user/project/workflow/idea 隔离 Key。仅在部署需要覆盖默认 bucket 时设置 `USER_PUBLIC_IMAGES_BUCKET`。

启用现有 `LANGFUSE_ENABLED=true` 后，每次任务只产生一个名为 `idea` 的 trace。发明、审计、收敛和图片生成是其阶段 span；每个 Pi Agent 的 turn、token 与 cost 继续作为对应阶段的子 observation，因此会自动汇总到同一个 trace。根 trace 记录 checkpoint attempt、图片失败数和最终状态，不记录图片 base64 或凭证。

每个 Profile 独立声明：

- 模型与 thinking level；
- 温度、最大轮次、超时和重试；
- 可使用的 MCP / `read` 工具；
- 随 Profile 注册的默认 Skill；
- 远程 Skill 的 `id + version`。

远程 Skill 是规则和生成规范的来源；创作者画像、作品事实、任务进度和奖励结果必须通过外部 MCP 获取，不能从 Skill 文本猜测。

## 开发命令

```bash
pnpm run typecheck  # 类型检查
pnpm test           # 测试
pnpm run build      # 构建 dist
pnpm run check      # 类型检查 + 测试 + 构建
pnpm start          # 运行构建产物
```

架构与部署说明：

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- [`docs/CREATOR-OPERATIONS-CONTEXT.md`](docs/CREATOR-OPERATIONS-CONTEXT.md)
