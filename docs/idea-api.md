# Idea Generate API

面向外部系统的 Idea API。客户端提交一次生成任务，随后轮询任务状态；服务会依次完成玩法发散、独立审核、收敛、效果图生成和 CDN 上传。

## 基本约定

- 测试环境 Base URL：`https://agent.sddev.org`。
- Content-Type：`application/json`。
- 测试环境当前无需鉴权，可以直接运行本文的 `curl` Case。
- 生产环境鉴权：`Authorization: Bearer <JWT>`。
- JWT 的 `sub` 必须和请求中的 `userId` 一致。
- 平台固定为 `Loopit 竖屏 Feed`，请求中不要传 `platform`。
- 通常需要 5–10 分钟完成，建议每 2 秒查询一次，并为整个轮询流程预留至少 10 分钟。
- 仅提供提交和查询两个 Idea 路由。

## 1. 提交生成任务

```http
POST /ideas/generate
Content-Type: application/json
Idempotency-Key: idea-doc-case-001
```

生产环境还必须携带 `Authorization: Bearer <JWT>`；测试环境不要添加该 Header。

`Idempotency-Key` 必填，长度为 8–128，只能包含字母、数字、`.`、`_`、`:`、`-`。相同用户使用同一个 Key 和相同请求时返回原任务；同一个 Key 对应不同请求时返回 `409`。

### 请求字段

| 字段 | 类型 | 必填 | 限制 |
| --- | --- | --- | --- |
| `userId` | string | 是 | 1–128 字符；必须等于 JWT `sub` |
| `projectId` | string | 否 | 1–128 字符；不传时默认为 `idea_create`，同时用于 CDN 路径 |
| `theme` | string | 是 | 创意主题，最多 2000 字符 |
| `audience` | string | 是 | 目标用户，最多 1000 字符 |
| `emotion` | string | 是 | 目标体验，最多 1000 字符 |
| `duration` | string | 否 | 默认 `30-60 秒`，最多 200 字符 |
| `notes` | string | 否 | 补充约束，最多 4000 字符 |
| `forbidden` | string | 否 | 禁止内容，最多 2000 字符 |
| `count` | integer | 否 | 1–8，默认 4 |

可直接运行的请求 Case 保存在 [`examples/idea-generate-request.json`](examples/idea-generate-request.json)：

```bash
BASE_URL="https://agent.sddev.org"

curl --fail-with-body --request POST "$BASE_URL/ideas/generate" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: idea-doc-case-001" \
  --data-binary @docs/examples/idea-generate-request.json
```

请求 JSON：

```json
{
  "userId": "idea-user",
  "projectId": "garden-demo",
  "theme": "会移动的微型花园，植物会争夺阳光",
  "audience": "喜欢轻松治愈但愿意快速判断的休闲玩家",
  "emotion": "治愈、短暂紧张、立即满足",
  "duration": "单局 30 秒",
  "notes": "必须单手操作，前 3 秒能看懂",
  "forbidden": "真实人物、品牌、Logo 和受版权保护素材",
  "count": 2
}
```

### 提交响应

新任务返回 `202 Accepted`：

```json
{
  "workflow": {
    "id": "idea_xxxxxxxxx",
    "userId": "idea-user",
    "projectId": "garden-demo",
    "status": "queued",
    "stage": "queued",
    "input": {
      "theme": "会移动的微型花园，植物会争夺阳光",
      "audience": "喜欢轻松治愈但愿意快速判断的休闲玩家",
      "emotion": "治愈、短暂紧张、立即满足",
      "platform": "Loopit 竖屏 Feed",
      "duration": "单局 30 秒",
      "notes": "必须单手操作，前 3 秒能看懂",
      "forbidden": "真实人物、品牌、Logo 和受版权保护素材",
      "requestedCount": 2
    },
    "ideas": [],
    "createdAt": "2026-07-17T00:00:00.000Z",
    "updatedAt": "2026-07-17T00:00:00.000Z"
  },
  "idempotentReplay": false
}
```

如果相同请求已经完成，幂等重放可能直接返回 `200 OK` 和原任务结果。

## 2. 查询状态和结果

```http
GET /ideas/{workflowId}?userId=idea-user
```

生产环境还必须携带 `Authorization: Bearer <JWT>`。

```bash
curl --fail-with-body \
  "$BASE_URL/ideas/$WORKFLOW_ID?userId=idea-user"
```

查询成功始终返回 `200 OK`。根据 `workflow.status` 判断是否完成：

| status | 含义 | 是否继续轮询 |
| --- | --- | --- |
| `queued` | 已入队 | 是 |
| `running` | Agent 或图片阶段运行中 | 是 |
| `completed` | 所有 Idea 和图片成功 | 否 |
| `completed_with_errors` | 文本完成，但至少一张图片失败 | 否 |
| `failed` | Workflow 失败，查看 `workflow.error` | 否 |

`workflow.stage` 可能为 `queued`、`invent`、`audit`、`converge`、`images`、`complete`。

### 完成结果结构

```json
{
  "workflow": {
    "id": "idea_xxxxxxxxx",
    "userId": "idea-user",
    "projectId": "garden-demo",
    "status": "completed",
    "stage": "complete",
    "input": {
      "theme": "会移动的微型花园，植物会争夺阳光",
      "audience": "喜欢轻松治愈但愿意快速判断的休闲玩家",
      "emotion": "治愈、短暂紧张、立即满足",
      "platform": "Loopit 竖屏 Feed",
      "duration": "单局 30 秒",
      "notes": "必须单手操作，前 3 秒能看懂",
      "forbidden": "真实人物、品牌、Logo 和受版权保护素材",
      "requestedCount": 2
    },
    "ideas": [
      {
        "id": "light_path",
        "title": "光之轨迹",
        "summary": "划出反射路径，把阳光引向花朵并避开杂草。",
        "mechanic": "绘制短暂反射线改变光束轨迹",
        "interactionPattern": "swipe-path",
        "playerGoal": "在倒计时结束前让尽可能多的花朵开花。",
        "playerAction": "单指划线改变光束方向。",
        "gameState": "花苞、杂草和光束位置持续变化。",
        "decision": "判断本次划线的角度和落点。",
        "rules": "光束击中花苞得分，击中杂草会扩大遮挡。",
        "loop": "观察光束，判断路径，划线反射，查看结果并进入下一次判断。",
        "failState": "杂草遮满屏幕或时间耗尽。",
        "feedback": "花朵绽放、光粒和清脆音效。",
        "failureRecovery": "单次失误只扩大杂草，下一束光仍可继续。",
        "whyFun": "即时改变光路，并看到花园由暗转亮。",
        "prototypeTest": "测试玩家能否在 30 秒内连续完成三次有效反射。",
        "difficultyCurve": "光束逐渐增多，杂草位置更靠近花苞。",
        "variationSource": "每局重新排列植物和光束入口。",
        "first10Seconds": "先展示一次自动反射，再让玩家完成三次简单划线。",
        "funRisks": "需要验证划线角度是否对休闲玩家足够宽容。",
        "bindingRationale": "争夺阳光直接决定植物生长和杂草扩张。",
        "gatePassed": true,
        "fatalReasons": [],
        "audit": {
          "loopPass": true,
          "predictionPass": true,
          "interactionPass": true,
          "feasibilityPass": true,
          "fatalReasons": [],
          "evidence": "光束方向和目标位置均为可见信息。",
          "recommendedDowngrade": "无需降级"
        },
        "imagePrompt": "竖屏花园游戏画面，展示可操作光路、花苞、杂草和即时反馈。",
        "image": {
          "status": "completed",
          "url": "https://cdn-cf.loopit.me/public/game/garden-demo/idea_xxxxxxxxx/workspace/dist/ideas/light_path.png",
          "mimeType": "image/png",
          "model": "gpt-image-2",
          "storage": "s3"
        }
      }
    ],
    "createdAt": "2026-07-17T00:00:00.000Z",
    "updatedAt": "2026-07-17T00:03:00.000Z",
    "startedAt": "2026-07-17T00:00:01.000Z",
    "completedAt": "2026-07-17T00:03:00.000Z"
  }
}
```

实际 `ideas` 数量等于请求中的 `count`。审核失败的候选不会伪装成通过：`gatePassed=false`，并保留 `audit.fatalReasons`、`audit.evidence` 和 `audit.recommendedDowngrade`，最终仍由用户选择。

生产环境成功图片的 URL 结构为 `https://cdn-cf.loopit.me/public/game/{projectId}/{workflowId}/workspace/dist/ideas/{ideaId}.png`。测试环境使用相同路径结构，域名为 `https://cdn-cf-dev.loopit.me`。如果单张图片在内部重试后仍失败，该图片返回 `status=failed` 和 `error`，任务状态为 `completed_with_errors`；已生成的 Idea 文本和其他成功图片仍会正常返回。

## 完整轮询 Case

需要安装 `curl` 和 `jq`：

```bash
set -euo pipefail

BASE_URL="https://agent.sddev.org"

submit_response=$(curl --fail-with-body --silent --show-error \
  --request POST "$BASE_URL/ideas/generate" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: idea-doc-case-001" \
  --data-binary @docs/examples/idea-generate-request.json)

workflow_id=$(jq -r '.workflow.id' <<<"$submit_response")

while true; do
  result=$(curl --fail-with-body --silent --show-error \
    "$BASE_URL/ideas/$workflow_id?userId=idea-user")
  status=$(jq -r '.workflow.status' <<<"$result")
  case "$status" in
    queued|running) sleep 2 ;;
    completed|completed_with_errors) jq '.workflow.ideas' <<<"$result"; break ;;
    failed) jq '.workflow' <<<"$result"; exit 1 ;;
    *) echo "unknown workflow status: $status" >&2; exit 1 ;;
  esac
done
```

不要在重试提交时生成新的 `Idempotency-Key`，否则会创建新任务。客户端请求超时后，应使用原 Key 重放提交请求或使用已获得的 `workflow.id` 继续查询。

## 错误响应

| HTTP | 场景 |
| --- | --- |
| `400` | JSON 字段、类型、范围或 `Idempotency-Key` 不合法 |
| `401` | JWT 缺失、无效或过期 |
| `403` | 提交请求的 `userId` 与 JWT `sub` 不一致 |
| `404` | 查询任务不存在，或任务不属于该用户 |
| `409` | 幂等键冲突，或同一用户已有 2 个运行中的 Idea 任务 |
| `429` | 超过服务限流 |
| `503` | Idea Workflow 未启用 |
| `500` | 未预期服务错误 |

错误响应统一包含 `error`：

```json
{
  "error": "error message"
}
```
