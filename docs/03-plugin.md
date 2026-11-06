# DSH Go 插件：local-wechat-bridge

位置：`~/.dsh/dsh-go/plugins/local-wechat-bridge/`

## 目录

```
lib/
  index.js            插件入口：起服务、装面板
  panels.js           两个面板（微信参数 / AI 管理）
  bridge/
    server.js         HTTP 服务与消息处理
    store.js          配置、白名单、会话、记忆
    model.js          提示词拼装、模型调用、记忆整理
    reply.js          切句与延迟
    news.js           每日趣事：抓热榜 + 让模型用自己的话讲
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
| `segments.maxLen` | 每段字数，**硬上限 30** | 15 / 20 / 25 / 30 |
| `segments.max` | 最多几段 | 1 / 2 / 3 |
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

## 两个面板

### 微信参数（`全部功能` / `对话详情页`）

- 白名单：列表显示当前条目，每项可移除；「加入最近来信的人」一键加；可清空、重载
- 回复速率：秒回 / 快 / 正常 / 慢 / 很慢（改的是 `firstDelayMs` + `segmentDelayMs`）
- 分段数：1–3
- 每段字数：15 / 20 / 25 / 30

### AI 管理（`全部功能` / `对话详情页`）

- 模型目录：`llm.listProviders()` + `llm.listModels(provider)` 实时读取，官方和中转站都在
- 选模型：**先真发一条「在吗」探测**，通了才写配置，不通提示具体错误
- 上下文轮数、回复上限、限流
- 人设：显示是否在用 `persona.md`、字数；可重载
- 记忆：显示当前会话记忆字数；可整理 / 清空

面板里没有文本输入组件，所以**字符串配置只能改文件**（人设、模型名以外的内容）。

## 关键实现约定

- 切句（`reply.js`）：整句 ≤上限就一条发完；超过才在标点处切，均分不留残段；剥掉 `-` `*` `·` 这类列表符；≤2 字的碎段并进上一段
- 段数上限是硬上限，多出来的不发（避免某段被撑大）
- 延迟 = 区间随机 + 按字数加权（最多 +2500ms），模拟打字
- 断句规则：先按句末标点断句；单句超过长度上限时只在逗号处切，附近没逗号就整句发（绝不从词中间切开）；段末逗号顿号自动去掉
- 去重：模块侧按 `talker|content|createTime` 10 秒窗口，插件侧按 `msgId`
- 失败不重试：模型报错就回 `MODEL_ERROR`，模块放弃这条
- 桥接服务在引擎里跑，**改 `lib/` 下的代码要重启引擎**；改 `package.json` 由宿主自动重载
