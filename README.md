# WeChat × DSH：让个人微信有个像真人的 AI 搭子

用 **LSPosed 模块 Hook 微信**收发消息，把「回什么、怎么回、多久回」全部交给 **DSH Go 插件 + 云端大模型**。

不是客服机器人：有人设、有长期记忆、会分段、会按节奏发消息，回一句话最多 30 字。

```
别人发微信
  │
  ├─ LSPosed 模块（微信进程内）读数据库拿到消息
  │        │ HTTP 127.0.0.1:18765
  │        ▼
  ├─ DSH Go 插件：人设 + 记忆 + 最近 16 轮上下文 → 云端模型
  │        │ 切句（≤30 字/段，≤3 段）+ 随机延迟
  │        ▼
  └─ 模块调用微信原生发送流程逐段发出
```

## 环境要求

| 项 | 要求 |
|---|---|
| 手机 | 已 Root（KernelSU / Magisk），装了 LSPosed |
| 微信 | **8.0.76**（本项目的混淆符号按此版本写，其它版本要重新定位，见 `docs/04-wechat-8076.md`） |
| DSH | DSH Go App（插件跑在它的引擎里，模型也由它提供，**不需要自己填 API Key**） |

## 目录

```
lsposed-module/     Android 模块源码（Java，无 Gradle 依赖也能构建）
dsh-plugin/         DSH Go 插件（Node，无 npm 依赖）
docs/               架构、协议、微信锚点、人设记忆、开发流程
```

## 安装

### 1. 模块

```bash
cd lsposed-module
bash tools/build-apk.sh          # 产物 build/manual/wechat-bridge-<VERSION>.apk
```

装 APK → LSPosed 里启用 → 作用域勾选 **微信** → 强制停止微信再打开。

模块日志会通过 `POST /api/log` 推回插件，落进 `dsh-plugin/data/bridge.log`，能看到 `WeChatBridge <版本> 启动`。

### 2. 插件

```bash
dsh plugin --profile web add /path/to/dsh-plugin
```

（或直接把 `dsh-plugin/` 放进 `$DSH_HOME/dsh-go/plugins/local-wechat-bridge/`）

首次启动会自动监听 `127.0.0.1:18765`。把 `examples/config.json`、`whitelist.json`、`persona.md` 复制进插件的 `data/` 目录并按需修改。

### 3. 白名单

**只回白名单里的人**。注意比对的是**发消息的人**的 wxid：

- 私聊：对方的 wxid
- 群聊：群 id（`@chatroom` 结尾） + 群里必须 @ 到 bot

面板「全部功能 → 微信参数」里可以一键加入最近来信的人。

## 面板

| 面板 | 能做什么 |
|---|---|
| **微信参数** | 白名单增删、回复速率、分段数（1–3）、每段字数（15–30） |
| **AI 管理** | 实时列出 DSH 里所有渠道和模型（官方/中转站）并可切换、上下文轮数、回复上限、限流、人设重载、记忆整理 |

选模型时会**先真发一条探测消息**，通了才写配置，不会出现“选完就不回了”。

## 人设与记忆

- 人设：`data/persona.md`，整段提示词，支持 `{{name}}` `{{who}}` `{{where}}` `{{summary}}` `{{memory}}`
- 记忆：`data/memory/<wxid>.md`，每 5 条对话自动整理一次，注入上限 1200 字

详见 `docs/05-persona-and-memory.md`。

## 已知限制

- 只回文本。收到表情包/图片/语音会转成 `[表情: 名字]`/`[图片]`/`[语音]` 占位文字（表情名从 `EmojiInfo` 表查，查不到就是 `[表情]`），bot **不会发真表情包**
- 群聊链路代码支持，但没有做端到端验证
- 引擎重启期间收到的消息直接丢弃，不补发
- 微信升级会改混淆名，需要重找 `y11.s1` / `e01.e2`

## 风险

Hook 微信属于非官方行为，**存在账号风险**，建议先用小号。聊天内容会发送到云端模型。详见 `docs/07-risk-notes.md`。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/00-README.md` | 总览与安装 |
| `docs/01-architecture.md` | 架构、进程、链路 |
| `docs/02-message-protocol.md` | 模块↔插件 HTTP 协议 |
| `docs/03-plugin.md` | 插件结构、配置、面板 |
| `docs/04-wechat-8076.md` | 微信 8.0.76 的 Hook 锚点与收发配方 |
| `docs/05-persona-and-memory.md` | 人设、记忆、分段规则 |
| `docs/06-dev-workflow.md` | 改代码、构建、验证、踩坑 |
| `docs/07-risk-notes.md` | 隐私、封号、版本漂移 |

## License

MIT
