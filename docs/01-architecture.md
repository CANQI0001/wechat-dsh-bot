# 运行架构

## 进程与职责

| 位置 | 运行内容 | 说明 |
|---|---|---|
| 微信主进程 `com.tencent.mm` | LSPosed 模块 | 唯一能收发消息的进程，必须注入成功 |
| 微信其他进程 `:appbrand0` 等 | 同一个模块 | 也会加载，但只记日志，不处理消息 |
| DSH Go 引擎 | 插件 `local-wechat-bridge` | 起 HTTP 服务，调模型，管状态 |

模块和插件**不在同一个进程**，靠 `127.0.0.1:18765` 通信。手机本地回环，外部访问不到。

## 一次完整往返

```
① 对方发消息
② 微信把消息写入数据库（WCDB）
   └─ 模块 hook SQLiteDatabase.insert 系列拿到 ContentValues
③ 模块过滤：isSend=0、在白名单、群聊需 @
④ POST /api/message  {type:"message.in", ...}
⑤ 插件：去重 → 限流 → 追加历史 → 读记忆 → 拼提示词
⑥ 调云端模型（流式），拿到整段文本
⑦ 切句（≤30 字/段，≤3 段）+ 随机延迟
⑧ 返回 {type:"reply.out", segments:[...], delayMs, segmentDelayMs}
⑨ 模块按延迟逐段发送：y11.s1.a(talker) 造消息实体 → 入队
10 微信自己完成上传与展示
```

第 ⑦ 步的延迟让回复不像机器秒回；第 ⑨ 步用的是微信原生发送流程，所以消息会正常入库、显示已发送。

## 为什么收消息走数据库层

微信 8.x 把 `com.tencent.mm.storage` 整个混淆成短名（消息实体 `y11.r1`，并不存在 `MsgInfo` 这个类），每个版本都变。但 WCDB 是腾讯自研 SDK，类名 `com.tencent.wcdb.database.SQLiteDatabase` 稳定，且所有消息都经过它落库；表名 `message` 与列名是 schema，跨版本基本不变。

代价：拿到的是**落库后的数据**，比 UI 层晚几十毫秒，可以接受。

## 为什么发消息要调 `y11.s1`

构造消息实体再入队是微信自己发消息的路径（详见 04）。试过的其它入口（`uk` 克隆、`kl5.s5`、`tk#o0`）都不是文本发送的实际路径，已删除，不要再走。

## 状态与日志

- `/api/health`：引擎是否活着、当前模型、暂停状态
- `/api/log`：模块把日志 POST 回插件，落进插件 `data/bridge.log`，每行带进程名前缀（`com.tencent.mm` / `:appbrand0`），排查注入问题全靠它
- 面板显示：运行状态、今日消息数、白名单人数、当前模型

## 数据落地

| 内容 | 位置 |
|---|---|
| 配置 | 插件 `data/config.json` |
| 白名单 | 插件 `data/whitelist.json`（改动后按 mtime 热加载） |
| 人设 | 插件 `data/persona.md` |
| 长期记忆 | 插件 `data/memory/<wxid>.md` |
| 会话历史 | 插件 `data/sessions/<wxid>.json` |
| 日志 | 插件 `data/bridge.log` |
