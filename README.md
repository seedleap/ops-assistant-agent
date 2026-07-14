# Loopit 创作者运营助手

这是一个面向 Loopit 创作者的运营助手智能体。创作者把作品链接、作品 ID（PID）或用户 ID（UID）发给它，它会查询真实作品数据，结合玩家评论、创作历程和运营知识库，给出清楚、可执行的作品诊断和优化建议。

项目名是 `ops-assistant-agent`。这里保留这个英文名，是为了和代码目录、包名、仓库名一致。

## 它能做什么

- 看作品全貌：输入一个作品 ID，就能查看作品画像、最近数据、高赞评论和最初创作提示词。
- 看数据表现：查询最近几天或指定日期范围内的曝光、播放、10 秒播放、观看时长、点赞、评论、收藏等指标。
- 看玩家反馈：按高赞或最新顺序读取评论，总结玩家喜欢什么、吐槽什么、还想要什么。
- 复盘创作过程：查看每一轮创作者说了什么、智能体实际做了什么，判断作品现在有哪些玩法和问题。
- 看创作者作品列表：输入用户 ID，列出这个创作者名下的作品，再继续挑作品分析。
- 读取运营知识库：可以读取创作指导、热门案例、当前活动等资料，给创作者推荐合适的优化方向或活动。
- 主动触达创作者：按定时任务检查是否值得打扰创作者，例如作品涨了一波、有新热评、有合适活动；如果不值得打扰，会主动跳过。
- 本地聊天调试：启动后有一个仿真聊天页面，可以像私信一样和智能体对话，并看到它正在查什么数据。

## 数据从哪里来

主链路查的是真实生产数据：

```text
智能体查询工具
  -> 官方 MCP Client（Streamable HTTP）
  -> Loopit 数据 MCP 服务
  -> 外部业务 API / 数据服务
```

本项目不生成 SQL，也不持有数据仓库口径。远端 MCP 服务提供以下六个只读业务工具：

- `query_creator_works`
- `query_work_profile`
- `query_work_consumption`
- `query_work_comments`
- `query_work_prompt`
- `query_work_overview`

部署时配置远程 Streamable HTTP endpoint：

```bash
OPS_MCP_URL=https://ops-data.example.com/mcp
OPS_MCP_TOKEN=<service-token>
OPS_MCP_TIMEOUT_MS=120000
OPS_MCP_MAX_RESPONSE_BYTES=2097152
```

Agent 只允许调用这六个固定名称，不会动态接受远端新增工具。首次查询时执行 MCP 初始化与工具清单校验，服务进程关闭时主动关闭连接。

当前覆盖的数据包括：

- 作品基础信息：标题、作者、发布状态、玩法标签、质量等级、创建和发布时间。
- 作品消费数据：曝光、播放、10 秒播放、观看时长、点赞、评论、收藏和转化率。
- 玩家评论：高赞评论、最新评论、主评论和楼中楼回复。
- 创作历程：初始提示词、后续提示词、每轮智能体回复。

所有业务日期按北京时间，也就是 UTC+8。

## Agent 运行与观测

项目使用最新版 `@earendil-works/pi-coding-agent` 管理模型、会话、重试、Compaction 和工具生命周期。交互对话与主动触达分别使用独立的 Agent Profile，可配置模型、thinking level、temperature、最大轮次和超时。

配置 Langfuse 后，每次运行会生成 Agent → turn → tool 的分层 trace，并记录模型参数、工具状态、Token、费用和最终结果。Langfuse 未配置或不可用时不会阻塞 Agent 主流程。

详细结构和边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 本地启动

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

启动后打开：

```text
http://localhost:8010/
```

这个页面就是本地聊天调试页面。

如果只想验证页面、接口和定时任务，不想真的调用模型，可以把 `.env` 里的这一项改成：

```bash
ASSISTANT_DRY_RUN=true
```

如果要真实调用模型，需要配置 Gemini 凭据。默认凭据文件路径是：

```text
config/google-credentials.json
```

下面这些文件不会提交到代码仓库：

- `.env`
- `config/*credential*.json`
- `config/*credentials*.json`
- `config/*-config.json`
- `data/`
- `runs/`
- `dist/`
- `node_modules/`

## 启动前检查

需要本机具备：

- Node.js 和 pnpm。
- Gemini 凭据，或设置 `ASSISTANT_DRY_RUN=true`。
- 可用的 Loopit 数据 MCP 服务，或设置 `ASSISTANT_DRY_RUN=true` 只验证本地链路。

可以先用 dry-run 启动，确认项目自身可以独立运行：

```bash
ASSISTANT_DRY_RUN=true pnpm run dev:once
```

环境变量会在进程启动时统一校验。端口、布尔值、模型参数、模型白名单或 Langfuse 凭据配置错误时，服务会直接给出具体配置项并退出，不会静默使用默认值。

`CORS_ORIGINS=*` 便于本地预览；部署到线上时应改为逗号分隔的管理端来源，例如 `https://ops.loopit.example`。

生产环境默认要求 HS256 JWT。通过 `API_JWT_SECRET` 配置后台与 Agent 服务共享的签名密钥，也可以用 `API_JWT_ISSUER`、`API_JWT_AUDIENCE` 进一步约束签发方和受众。`/health` 与静态页面保持公开，其余接口需要 `Authorization: Bearer <jwt>`。

## 构建与生产运行

项目要求 Node.js 22.19 及以上、pnpm 10。`packageManager` 字段固定了 pnpm 版本，CI 和本地统一使用 Corepack。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm start
```

`pnpm run check` 会依次执行类型检查、测试和生产构建。生产代码输出到 `dist/`，测试文件不会进入构建产物。

容器构建：

```bash
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -t ops-assistant-agent .
```

线上单机使用 `compose.production.yaml`，Kubernetes 使用 `deploy/k8s/production`。`.env.production` 应设置 `NODE_ENV=production`、`API_AUTH_MODE=jwt` 和强随机 `API_JWT_SECRET`。生产默认关闭内置调试页面，服务应放在内部鉴权网关之后。

完整的镜像构建、Secret 注入、持久卷和 Kustomize 发布说明见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 常用接口

发起一轮聊天，并流式返回过程：

```bash
curl -N -X POST http://localhost:8010/im/stream \
  -H 'content-type: application/json' \
  -d '{"userId":"im-user","text":"帮我看看作品 <PID> 怎么样"}'
```

记录用户消息，并让智能体回复：

```bash
curl -X POST http://localhost:8010/im/messages \
  -H 'content-type: application/json' \
  -d '{"userId":"u1","text":"帮我看看这个作品 <PID>","reply":true}'
```

创建一个定时触达任务：

```bash
curl -X POST http://localhost:8010/schedules \
  -H 'content-type: application/json' \
  -d '{
    "userId":"u1",
    "name":"每日创作者检查",
    "prompt":"检查这个创作者最近是否有值得提醒的作品变化、热评或活动机会。",
    "intervalMinutes":1440,
    "silentMinutes":60
  }'
```

手动触发一次定时任务扫描：

```bash
curl -X POST http://localhost:8010/scheduler/tick
```

查看待发送消息：

```bash
curl http://localhost:8010/outbox
```

标记某条消息已经发送：

```bash
curl -X POST http://localhost:8010/outbox/<messageId>/deliver
```

智能体内部会使用这些查询工具：

- `query_work_overview`：查作品全貌。
- `query_work_consumption`：查作品消费数据。
- `query_work_comments`：查玩家评论。
- `query_work_prompt`：查创作历程。
- `query_work_profile`：查作品基础信息。
- `query_creator_works`：查某个创作者的作品列表。
- `read_knowledge`：读取运营知识库。

具体工具选择和回复约束统一写在 `config/system-prompt.md`，运行时不会隐式加载其他 skill 指令。

## 配置文件

- `config/system-prompt.md`：智能体的系统提示词，可以通过页面或接口修改。
- `config/user-segments.json`：用户分层配置。
- `config/scheduled-tasks.json`：定时触达任务配置。
- `skills/creator-guide/`：创作指导知识库。
- `skills/ops-activities/`：运营活动知识库。

## 目录结构

```text
bin/                    命令行入口
config/                 系统提示、用户分层、定时任务配置
public/                 本地聊天调试页面
sample-data/            本地调试数据
skills/                 智能体可读取的运营知识库
src/                    服务、智能体、MCP client、调度器、工具定义
```

`POST /data/query` 会读取 `sample-data/*.json`，仅用于本地离线调试。智能体正式查数据时只走远程 MCP。

## 开发命令

```bash
pnpm run check
pnpm run dev:once
```

- `pnpm dev`：监听源码变化并自动重启。
- `pnpm run dev:once`：启动一次，适合脚本和冒烟测试。
- `pnpm run build`：生成可部署的 `dist/`。
- `pnpm start`：运行已经构建的生产代码。

## 接入到真实私信系统

当前服务会把主动触达生成的消息放进 `outbox`。接入真实私信系统时，把 `outbox` 里的待发送消息交给真实发送通道即可。

定时触达有几个规则：

- 用户主动聊天和后台触达使用不同的会话，互不污染上下文。
- 只有用户静默达到 `silentMinutes` 后，才会生成触达消息。
- 默认静默时间是 60 分钟，可以在每个定时任务里单独配置。
