# 消息协议（模块 ↔ 插件）

传输：HTTP/1.1 + JSON，UTF-8，监听 `127.0.0.1:18765`。没有 WebSocket，没有长连接。
鉴权：请求头带 `Authorization: Bearer <config.token>`；`token` 为空时不校验。

## 接口清单

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/message` | 上报一条收到的微信消息，同步返回回复 |
| POST | `/api/heartbeat` | 心跳，返回 `heartbeat.ack` |
| GET | `/api/health` | 运行状态 |
| GET | `/api/sessions` | 最近的会话列表 |
| DELETE | `/api/sessions/:id` | 删除某个会话的历史 |
| GET | `/api/config` | 读配置与白名单（token 会被剥掉） |
| POST | `/api/reload` | 重载白名单 |
| POST | `/api/log` | 模块把日志推上来（每批 ≤200 行、每行 ≤800 字） |

## 上行：message.in

```json
{
  "type": "message.in",
  "msgId": "db-1730000000-a1b2c3d4",
  "sessionId": "wxid_xxx",
  "chatType": "private",
  "sender": { "id": "wxid_xxx", "name": "阿伟", "remark": "阿伟" },
  "content": "在吗",
  "msgType": "text",
  "rawType": 1,
  "timestamp": 1730000000,
  "isGroup": false
}
```

| 字段 | 说明 |
|---|---|
| `type` | 固定 `message.in`，否则回 `INVALID_MSG` |
| `msgId` | 模块生成，用于插件去重（`sessionId:content:时间` 之外的第二道防线） |
| `sessionId` | 私聊=对方 wxid，群聊=群 id（`@chatroom` 结尾） |
| `sender.id` | **白名单比对的是这个**，不是 sessionId |
| `content` | 文本；非文本消息是占位符，见下 |
| `rawType` | 微信原始 type：1 文本 / 3 图片 / 34 语音 / 43 视频 / 47 表情 / 48 位置 / 49 链接文件 |
| `groupInfo` | 群聊时 `{groupId, groupName, atMe}` |

### 非文本占位约定

模块没有识图能力，非文本消息统一转成可读占位文字，再走同一条文本链路：

| 原始类型 | content |
|---|---|
| 3 | `[图片]` |
| 34 | `[语音]` |
| 42 | `[名片]` |
| 43 | `[视频]` |
| 47 | `[表情]` |
| 48 | `[位置]` |
| 49 | `[链接或文件]` |

模型收到这些占位后，按提示词要求自然接一句，不去描述内容。

## 下行：reply.out

```json
{
  "type": "reply.out",
  "msgId": "db-1730000000-a1b2c3d4",
  "sessionId": "wxid_xxx",
  "segments": ["在呢在呢", "咋啦"],
  "delayMs": 3200,
  "segmentDelayMs": 900
}
```

| 字段 | 说明 |
|---|---|
| `segments` | 1–3 段，每段 ≤30 字（插件强制） |
| `delayMs` | 第一段之前的随机延迟 |
| `segmentDelayMs` | 段间隔 |

模块收到后按延迟逐段发送；`segments` 为空表示这次不回复。

## 错误

HTTP 200 + `error` 体（模块按 code 记日志，不重试）：

```json
{ "type": "error", "code": "MODEL_ERROR", "message": "模型调用失败" }
```

| code | 含义 |
|---|---|
| `INVALID_MSG` | 不是 message.in |
| `PAUSED` | 面板里暂停了 |
| `DUPLICATE` | 重复消息 |
| `WHITELIST_DENIED` | 不在白名单 / 群聊没 @ |
| `RATE_LIMITED` | 超过每分钟条数 |
| `DSH_UNAVAILABLE` | 模型服务没就绪 |
| `MODEL_ERROR` | 模型报错（key 失效、模型不存在等） |
| `UNAUTHORIZED` | token 不对 |
| `NOT_FOUND` / `INTERNAL` | 路径错 / 其它异常 |

约定：**任何失败都不重试、不补发**。连不上就丢，日志里留一行。

## 主动发出（不受来信触发）

每日趣事这类「没人问但我要说」的消息走另一条路：

```
插件生成 -> 出站队列 data/outbox.json
模块每 5 秒 GET /api/outbox -> 拿到行 -> 排进发送队列
```

返回是纯文本行，字段用 tab 分隔，段之间也按 tab：

```
sessionId 	 delayMs 	 segmentDelayMs 	 第一段 	 第二段
```

模块取走后桥接立即清空，避免重复发。
