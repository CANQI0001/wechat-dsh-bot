# DSH Go 插件：local-wechat-bridge

位置：`~/.dsh/dsh-go/plugins/local-wechat-bridge/`

## 目录

```
lib/
  index.js            插件入口：起服务、装面板
  panels.js           四个面板（微信连接 / 模型与记忆 / 模块状态 / 每日趣事）
  bridge/
    server.js         HTTP 服务与消息处理
    store.js          配置、白名单、会话、记忆
    model.js          提示词拼装、模型调用、记忆整理
    reply.js          切句与延迟
    news.js           每日趣事：抓热榜 + 让模型用自己的话讲
    vision.js         识图：直连视觉模型（不经引擎）
    ocr.js            本地识字（tesseract，中文）
    log.js            日志
data/
  config.json         模型、节奏、分段、限流
  whitelist.json      谁的消息会回
  persona.md          人设（整段提示词）
  memory/<wxid>.md    每个联系人的长期记忆
  sessions/<wxid>.json 最近对话
  bridge.log          运行日志
```

## config.json

| 字段 | 说明 | 常见值 |
|---|---|---|
| `port` / `host` | 监听地址 | `18765` / `127.0.0.1` |
| `token` | 可选鉴权 | 空 |
| `paused` | 暂停后一律不回 | `false` |
| `provider` / `model` | 用哪个模型 | `siliconflow` / `deepseek-ai/DeepSeek-V4.1-Flash` |
| `maxTokens` | 单次回复上限 | 256 / 512 / 1024 |
| `rateLimitPerMinute` | 每分钟最多回几条 | 6 / 12 / 30 |
| `historyTurns` | 带多少轮上下文 | 4 / 6 / 10 / 16 |
| `segments.maxLen` | 单段软上限，超过才在逗号处断 | `45` |
| `segments.max` | 段数保护上限，超了并进最后一段不丢字 | `6` |
| `vision.provider` / `vision.model` | 识图服务商 / 模型 | `siliconflow` / `Qwen/Qwen3-VL-8B-Instruct` |
| `daily` | 每日趣事：开关、时间、目标会话 | `{enabled,time,target,lastSentDay}` |
| `segments.firstDelayMs` | 首段延迟区间 | `[1000,2000]` |
| `segments.segmentDelayMs` | 段间隔区间 | `[500,1200]` |
| `persona.name` | 人设名（`{{name}}` 取值） | `小鱼` |

## whitelist.json

```json
{ "enabled": true, "private": ["wxid_xxx"], "groups": [], "groupWakeWords": ["@小鱼"] }
```

- `private` 里放**发消息的人**的 wxid（不是聊天对象的 wxid，群里尤其注意）
- `groups` 放群 id（`@chatroom` 结尾）
- 文件按 mtime 热加载，改完不用重启；面板里改会立即落盘

## 四个面板

| 面板 | 座位 | 内容 |
|---|---|---|
| 微信连接 | 全部功能 / 对话详情 | 白名单增删、最近来信一键加、回复节奏 |
| 模型与记忆 | 全部功能 / 对话详情 | 模型目录、探测后选模型、上下文、限流、人设、记忆、**识图服务商与识图模型** |
| 微信模块 | 全部功能 | 只读状态：模块版本、保活、DB Hook、最近一条收消息延迟 |
| 每日趣事 | 全部功能 / 对话详情 | 开关、时间、目标会话、现在就讲一条 |

识图模型是独立的一套：换聊天模型不影响识图，换识图模型也不影响聊天。

面板里没有文本输入组件，字符串配置（人设、目标会话）只能改文件。

## 关键实现约定

- 分段（`reply.js`）：模型用换行决定发几条——**一个话题就一条**；提示词禁止为凑段拆句
- 单段超过 45 字才在逗号处断，没逗号就整句发（绝不从词中间下刀）
- 很长的段落（>25 字）隔一个逗号换成空格、去掉句尾句号，像手打字
- 段数超过 6 才合并，且并进最后一段，不丢字
- 延迟 = 区间随机 + 按字数加权（最多 +2500ms），模拟打字
- 去重：模块侧按 `talker|content|createTime` 10 秒窗口，插件侧按 `msgId`
- 失败不重试：模型报错就回 `MODEL_ERROR`，模块放弃这条
- 桥接服务在引擎里跑，**改 `lib/` 下的代码要重启引擎**；改 `package.json` 由宿主自动重载

## 图片消息（识图）

```
收到图片 → 模块等缩略图落盘（最多 15 秒）
        → 缩到长边 640 / JPEG 70 → base64 附在 image 字段
        → 插件：本地 OCR 读图里的字
        → 视觉模型只做客观描述（不带人设）
        → 聊天模型把描述 + 文字用自己的语气说出来
```

- 识图**不经 DSH 引擎**：引擎模型目录里没有视觉模型，直连服务商 OpenAI 兼容接口
- SiliconFlow 的 `.cn` 和 `.com` 是两个独立平台，key 不通用，插件固定用 `.cn`
- 视觉模型失败时退回纯文本，至少还会接一句
- 自定义表情包看不出内容，**直接忽略**；微信自带表情按名字（`[表情: 微笑]`）接
