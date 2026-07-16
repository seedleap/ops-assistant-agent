# Loopit 创作者运营 Agent

面向创作者运营场景的 Agent 服务：通过 IM 生成个性化触达内容，按需读取运营知识和远程业务 Skill，并通过 MCP 查询创作者、作品和活动数据。

## 当前能力

- Gemini / Vertex 模型调用，支持 Profile 级模型、参数、提示词和工具白名单。
- `/im/messages` 一次性返回 JSON。
- `/im/stream` 以 SSE 流式返回文本、工具调用、用量和最终结果。
- 对话按 `userId + imThreadId` 持久化，可继续已有 Session。
- 默认 Skill 按 Pi 规范使用 `<name>/SKILL.md`，会话启动时注册到 system prompt，由内置 `read` 工具按需加载。
- 远程业务 Skill 从 S3 物料化到会话目录，同样由 Pi 内置 `read` 工具只读加载。
- 运营知识库通过 `read_knowledge` 工具读取。
- Loopit 业务数据通过 Streamable HTTP MCP 访问，不在本项目内实现数据查询逻辑。
- 可选 Langfuse trace，记录模型、工具、Token 和费用信息。

## 快速启动

要求 Node.js 22.19+、pnpm 10+。

```bash
corepack enable
pnpm install
pnpm dev
```

本地直接使用项目根目录的 `.env`；测试和生产分别使用 `.env.test`、`.env.production`，这些文件中的 Langfuse 配置已与 Carmack 对齐。

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

每个 Profile 独立声明：

- 模型与 thinking level；
- 温度、最大轮次、超时和重试；
- 可使用的 MCP / `read_knowledge` / `read` 工具；
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
