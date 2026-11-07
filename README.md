# WeChat × DSH：让个人微信有个像真人的 AI 搭子

用 **LSPosed 模块 Hook 微信**收发消息，把「回什么、怎么回、多久回」全部交给 **DSH Go 插件 + 云端大模型**。

不是客服机器人：有人设、有长期记忆、会看图、会按节奏发消息，一句话能说完就只发一条。

```
别人发微信
  │
  ├─ LSPosed 模块（微信进程内）读数据库拿到消息
  │        │ HTTP 127.0.0.1:18765
  │        ▼
  ├─ DSH Go 插件：人设 + 记忆 + 最近 16 轮上下文 → 云端模型
  │        │ 分段由内容决定 + 随机延迟
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

## 从零复现（给想用这个仓库的人）

前提：一台已 Root 的安卓手机 + LSPosed + **微信 8.0.76** + DSH Go App。

**1. 构建模块**

需要 `javac`(JDK 17)、`d8`、`aapt`、`zipalign`、`apksigner`，以及三个依赖文件：

```bash
# Android 平台 jar（SDK 里有）
export ANDROID_JAR=/path/to/android-sdk/platforms/android-23/android.jar
# Xposed API（LSPosed 仓库的 api 模块）
export XPOSED_JAR=/path/to/xposed-api.jar
# R8 / d8
export R8_JAR=/path/to/r8.jar
bash tools/build-apk.sh     # 产物 build/manual/wechat-bridge-<VERSION>.apk
```

装 APK → LSPosed 启用 → 作用域只勾微信 → 强制停止微信再开。

**2. 装插件**

```bash
dsh plugin --profile web add /path/to/dsh-plugin
```

**3. 填配置**

把 `dsh-plugin/examples/` 里的 `config.json`、`whitelist.json`、`persona.md` 复制到插件 `data/`：

- `whitelist.json` 填**你自己的 wxid**（不知道就随便发一条消息，日志里会打印）
- `config.json` 填模型；想用识图，填 `vision.apiKey`（SiliconFlow 的 key，注意用**国内站 .cn** 申请的）

**4. 验证**

给对方发一条消息，面板「微信模块」看版本和最近收消息延迟；日志出现 `WeChatBridge 1.2.18 启动` 就正常。

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
| **微信连接** | 白名单增删、最近来信一键加、回复节奏 |
| **模型与记忆** | 实时列出 DSH 所有渠道和模型、探测后切换、上下文、限流、人设、记忆、识图模型 |
| **微信模块** | 只读状态：模块版本、保活、DB Hook、最近收消息延迟 |
| **每日趣事** | 定时在冷场时讲一条热榜的事，用她自己的话说 |

选模型时会**先真发一条探测消息**，通了才写配置，不会出现“选完就不回了”。

## 人设与记忆

- 人设：`data/persona.md`，整段提示词，支持 `{{name}}` `{{who}}` `{{where}}` `{{summary}}` `{{memory}}`
- 记忆：`data/memory/<wxid>.md`，每 5 条对话自动整理一次，注入上限 1200 字

详见 `docs/05-persona-and-memory.md`。

## 已知限制

- **能看图**：图片走 OCR + 视觉模型，再由聊天模型用自己的语气说；但拿到的是缩略图（点开过的图会清晰些）
- **不会发表情包/图片**：只发文字
- 自定义表情包看不出内容，**直接忽略不回**；微信自带表情按名字（`[表情: 微笑]`）接
- 语音、位置、链接还是占位文字
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
