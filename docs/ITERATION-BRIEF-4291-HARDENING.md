# Revision 4291 运行加固迭代 Brief

> 状态：部分被 v6 行为契约迭代取代。`read` 注册、上下文 UID 绑定和链接解析继续保留；`ok + as_of` 强制拦截已按产品阶段要求撤除，改为非阻断的 `data / meta / error` 归一化。

日期：2026-07-23

## 目标

确保 v5 不仅在静态 Profile 和提示词层符合 RPD revision 4291，而且真实会话能够启动、作品链接能够确定性转换成 PID、模型不能选择其他 UID 查询账号或活动、数据缺少时间字段时不会继续生成结论。

## 用户价值

- 分享作品链接可以直接分析，不因把整条 URL 当成 PID 而失败。
- 当前账号和活动查询始终绑定调用方提供的运行上下文 UID，用户文本不能诱导模型改写 UID。
- FAQ Skill 所需的 Pi 内置 `read` 工具能够真实启用。
- 数据响应缺少 `as_of` 时明确降级，避免把不完整响应包装成确定结论。

## 基线与候选

- 基线：commit `698503a`，Profile/工具范围已对齐 revision 4291。
- 候选：在 session 组合层、工具适配层和业务结果 guard 上做最小加固。

## 假设

1. 区分 Pi 内置工具和自定义工具，可以消除真实会话启动时的 `unknown tool: read`。
2. 在创建会话时注入当前 Creator UID，并从 Agent 参数 Schema 移除 UID，可以阻断模型参数越权。
3. 在适配器中解析 PID/URL，比提示词要求模型自行解析更稳定。
4. 对业务结果强制 `ok + as_of`，可以把上游契约缺失转成可观测失败。

## 非目标

- 不增加 revision 4291 一期之外的场景。
- 不实现活动后台写操作、IM 审核、FAQ 索引或远端 MCP 数据。
- 不把服务 JWT subject 映射成 Creator UID；用户身份真实性仍由上游调用服务负责。
- 不修改模型、温度和运行预算。
- 不把本地 mock 或单元测试宣称为线上 Agent 效果证明。

## 评测设置

本仓库是 Creator Support 服务，不是生成 playable 的 Skill；`carmack-sse` 和 `loopit-chain` 无法隔离验证本轮 HTTP/session/MCP 组合变量，因此本轮不消耗在线 playable runner。

采用小样本契约测试：

- 内置 `read` + 自定义工具组合；
- 未知/重复工具拒绝；
- PID、路径 URL、查询参数 URL 与非法链接；
- UID 注入覆盖模型伪造 UID；
- 成功响应缺少 `as_of` 时失败；
- revision 4291 路由集与现有全量回归。

## 接受门槛

- 新增用例全部通过；
- 原有测试、类型检查、构建和 Skill 校验无回归；
- Creator IM 工具仍保持 3 个，Outreach 仍保持 1 个；
- 不重新引入未来场景或活动写能力。
