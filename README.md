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
  -> scripts/ops_query.py
  -> 只读 SQL 网关（由部署环境配置）
  -> 数据仓库
```

`scripts/ops_query.py` 是数据查询入口。它只做两件事：

- 按固定口径生成只读 SQL。
- 调用当前项目配置的 SQL 网关，把结果整理成适合智能体理解的 JSON。

项目本身不依赖任何本机其他项目。部署时在 `.env` 里配置其中一种网关即可：

```bash
# 方式一：HTTP 网关
OPS_SQL_GATEWAY_URL=https://your-sql-gateway.example.com/query
OPS_SQL_GATEWAY_TOKEN=

# 方式二：命令行网关
OPS_SQL_GATEWAY_CMD=
```

HTTP 网关接收 JSON：

```json
{"sql":"SELECT ...", "timeoutMs":120000}
```

命令行网关从标准输入读取同样的 JSON，并向标准输出写出查询结果 JSON。

当前覆盖的数据包括：

- 作品基础信息：标题、作者、发布状态、玩法标签、质量等级、创建和发布时间。
- 作品消费数据：曝光、播放、10 秒播放、观看时长、点赞、评论、收藏和转化率。
- 玩家评论：高赞评论、最新评论、主评论和楼中楼回复。
- 创作历程：初始提示词、后续提示词、每轮智能体回复。

所有业务日期按北京时间，也就是 UTC+8。

## 本地启动

```bash
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
- Python 3。
- Gemini 凭据，或设置 `ASSISTANT_DRY_RUN=true`。
- 可用的只读 SQL 网关，或设置 `ASSISTANT_DRY_RUN=true` 只验证本地链路。

可以先用 dry-run 启动，确认项目自身可以独立运行：

```bash
ASSISTANT_DRY_RUN=true pnpm dev
```

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

## 直接查数据

配置好 SQL 网关后，也可以不启动服务，直接用命令行查真实数据：

```bash
./bin/ops-query overview --pid <PID> --days 7 --pretty
./bin/ops-query consumption --pid <PID> --days 7
./bin/ops-query consumption --pid <PID> --start 20260601 --end 20260607
./bin/ops-query comments --pid <PID> --sort hot --limit 100
./bin/ops-query comments --pid <PID> --sort latest --limit 100
./bin/ops-query prompt --pid <PID> --rounds 5
./bin/ops-query profile --pid <PID>
./bin/ops-query works --uid <UID> --limit 20 --public
```

智能体内部会使用这些查询工具：

- `query_work_overview`：查作品全貌。
- `query_work_consumption`：查作品消费数据。
- `query_work_comments`：查玩家评论。
- `query_work_prompt`：查创作历程。
- `query_work_profile`：查作品基础信息。
- `query_creator_works`：查某个创作者的作品列表。
- `read_knowledge`：读取运营知识库。

具体什么时候用哪个工具，写在 [`skills/ops-assistant/SKILL.md`](skills/ops-assistant/SKILL.md)。

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
scripts/ops_query.py    真实 Loopit 数据查询入口
skills/                 智能体可读取的运营知识库
src/                    服务、智能体、调度器、工具定义
```

`POST /data/query` 会读取 `sample-data/*.json`，用于本地离线调试。智能体正式查数据时走 `scripts/ops_query.py`。

## 开发命令

```bash
pnpm run typecheck
pnpm test
pnpm run query -- overview --pid <PID> --days 7 --pretty
```

## 接入到真实私信系统

当前服务会把主动触达生成的消息放进 `outbox`。接入真实私信系统时，把 `outbox` 里的待发送消息交给真实发送通道即可。

定时触达有几个规则：

- 用户主动聊天和后台触达使用不同的会话，互不污染上下文。
- 只有用户静默达到 `silentMinutes` 后，才会生成触达消息。
- 默认静默时间是 60 分钟，可以在每个定时任务里单独配置。
