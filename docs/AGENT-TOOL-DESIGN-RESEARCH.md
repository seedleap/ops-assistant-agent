# Agent 工具颗粒度调研与决策

更新时间：2026-07-23。

## 调研结论

最佳实践不是“所有能力做成一个万能工具”，也不是“后端每个 API 都暴露成一个 Agent 工具”，而是双层设计：

```text
Agent-facing business tools
  -> workflow aggregation / permission enforcement
  -> atomic MCP operations
  -> warehouse, search index, activity core
```

Agent 只看到少量、目的互斥、能直接完成高价值工作流的业务工具。原子查询继续存在于 MCP 与数据服务内部，供业务工具组合、调试和复用。

## 官方依据

- Anthropic 建议从少量高价值工作流工具开始，而不是机械包装现有 API；经常连续调用的操作可以在一个工具内部聚合，同时要避免功能重叠，并用评测观察冗余调用、错误参数和工具错误。[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- OpenAI 内部数据 Agent 曾把完整重叠工具集暴露给模型，实际导致混淆，随后限制并合并工具；同时强调权限透传、可核验结果和持续 eval。[Inside OpenAI's in-house data agent](https://openai.com/index/inside-our-in-house-data-agent/)
- MCP 规范要求工具具备唯一名称、清晰描述、JSON Schema 输入，并推荐结构化结果与 `outputSchema`；读写、幂等和开放世界属性需要明确标注。[MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- OpenAI 的 Agent 架构指南建议优先增强单 Agent 与工具集合，只有持续出现指令遵循或工具选择问题时才增加 Agent 编排复杂度。[A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)

## 颗粒度判断规则

### 应合并为业务工具

同时满足以下条件时合并：

- 同一用户目标，且经常连续调用；
- 权限主体、权威来源和数据新鲜度相同；
- 中间结果对最终回答没有独立价值；
- 合并可以减少 Token、往返次数或口径拼接错误。

例如公开作品画像、消费指标、Power、Hashtag 和评论摘要共同组成“作品数据上下文”，应由 `query_public_work` 聚合，再由 `analyze-project` Skill 形成结论。

### 应保持独立

满足任一条件时独立：

- 权限边界不同：本人作品与他人公开作品；
- 权威系统不同：作品数据与活动资格/奖励；
- 计算成本或降级方式不同：评论聚类与作品指标；
- 用户目标和输出结构明显不同：账号趋势与单作品诊断；
- 单独失败不应阻断其他场景。

### 不应暴露给主 Agent

- 通用 SQL、表名、任意 HTTP；
- 只包装一个数据库字段或后端 endpoint 的薄工具；
- 与其他工具高度重叠、模型难以判断差别的工具；
- 返回大量原始行、内部标签或无关技术 ID 的工具。

## Loopit revision 4291 分层

### 注册的业务工具：4 个

| Agent 工具 | 原子 MCP 操作 | 用户目标 |
| --- | --- | --- |
| `get_public_project_data` | `query_public_work` | 获取本人或他人的公开作品事实 |
| `get_public_comment_data` | `analyze_work_comments` | 获取公开作品点赞 Top50 评论 |
| `get_creator_account_data` | `query_creator_account_summary` | 获取账号近 7 日事实 |
| `get_activity_participation` | `query_creator_activity_status` | 获取资格、任务与激励状态 |

Creator IM Profile 只加载前三个；平台侧 Outreach Profile 只加载 `query_creator_activity_status`。两个 Profile 不共享数据工具，避免把活动后台状态误暴露到一期 IM Agent。

### 数据原语

`query_work_profile`、`query_work_consumption`、`query_work_comments`、`query_work_prompt`、`query_work_overview`、`query_creator_works` 保留在 MCP/数据层。它们用于组合业务工具、兼容旧链路和调试，但不进入主 Agent 的工具上下文。

## 输入输出约束

- 工具描述必须写清“何时用、何时不用、返回什么、不返回什么”。
- 输入统一使用 `project_ref / detail_level`，默认 `detail_level=summary`。
- 输出统一使用 `data / meta / error`；兼容旧响应，但当前阶段不强制拦截缺失 `as_of`。
- 业务结果统一返回 `ok`、`as_of`、`scope`、`facts`、`missing_fields`、`source_refs`、截断与分页信息。
- 作品和评论分析只接受公开 PID；收到 URL 时先提取 PID。
- 账号分析只接受认证上下文中的当前 UID。
- 活动状态只能由平台侧 `query_creator_activity_status` 读取，Creator IM 不据此替代活动后台。
- Creator Score、Level、L2 等内部标签只在服务端计算，不进入用户可见结果。

## 评测门槛

工具数量不是固定真理，必须由场景 eval 决定是否继续合并或拆分。至少跟踪：

| 指标 | 目标 |
| --- | --- |
| 主场景选对首个工具 | >= 95% |
| 不需要工具时误调用 | <= 3% |
| 平均工具调用数 | 常规场景 <= 2 |
| 权限边界违规调用 | 0 |
| 缺少 `as_of` 的数据回答 | 0 |
| 重复或等价工具调用 | <= 2% |
| P95 工具返回 Token | 按场景设上限并持续压缩 |

新增或拆分工具前，先用真实问题扩充 held-out eval；只有选错工具、参数错误或工作流冗余得到量化改善时才调整颗粒度。
