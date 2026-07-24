# Loopit 创作者运营 Agent

对齐飞书 RPD revision 4291 的一期创作者支持 Agent：覆盖公开作品分析、公开评论总结、当前账号分析、闲聊和产品/活动文档答疑；活动配置与状态由独立后台负责。

## 当前能力

- Gemini / Vertex 模型调用，支持 Profile 级模型、参数、提示词和工具白名单。
- `/im/messages` 一次性返回 JSON。
- `/im/stream` 以 SSE 流式返回文本、工具调用、用量和最终结果。
- 对话按 `userId + imThreadId` 持久化，可继续已有 Session。
- 默认 Skill 按 Pi 规范使用 `<name>/SKILL.md`，会话启动时注册到 system prompt，由内置 `read` 工具按需加载。
- 远程业务 Skill 从 S3 物料化到会话目录，同样由 Pi 内置 `read` 工具只读加载。
- 默认 Skill 及其 `docs/` 参考资料通过 Pi 内置 `read` 工具读取。
- Loopit 业务数据通过 Streamable HTTP MCP 访问，不在本项目内实现数据查询逻辑。
- Creator IM 加载 `analyze-project`、`summarize-comments`、`analyze-account`、`search-docs` 四个垂类 Skill，以及 3 个目的互斥的数据工具。
- 平台侧 Outreach Profile 只加载 `ops-activities` 与活动状态工具，不与 Creator IM 共用工具。
- `creator-inspiration` 作为未来候选保留，但 revision 4291 一期不加载。
- 作品画像、消费、评论、Prompt 等原子查询保留在 MCP/数据层组合。
- 作品工具在适配层统一解析 PID/分享链接；账号与活动 UID 由会话上下文注入，不接受模型参数覆盖。
- 业务数据对 Agent 统一为 `data / meta / error`；适配器兼容旧响应但暂不因缺少 `as_of` 强制失败。
- 跨会话记忆只保存明确偏好和可选 IANA 时区；每轮另外注入当前 UTC/本地时间，线程内保留短期上下文。
- 所有分析要求携带数据窗口或 `as_of`；Creator Score、Level、L2 等内部标签不向创作者展示。
- `evals/tool-routing-cases.json` 固化典型场景、预期业务工具链和零工具问答，防止工具颗粒度回归。
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
- [`docs/CREATOR-SUPPORT-ARCHITECTURE.md`](docs/CREATOR-SUPPORT-ARCHITECTURE.md)
- [`docs/AGENT-TOOL-DESIGN-RESEARCH.md`](docs/AGENT-TOOL-DESIGN-RESEARCH.md)
- [`docs/RPD-REVISION-4291-DELTA.md`](docs/RPD-REVISION-4291-DELTA.md)
- [`docs/ITERATION-BRIEF-4291-HARDENING.md`](docs/ITERATION-BRIEF-4291-HARDENING.md)
- [`docs/ITERATION-BRIEF-V6-MEMORY-CONTRACT.md`](docs/ITERATION-BRIEF-V6-MEMORY-CONTRACT.md)
