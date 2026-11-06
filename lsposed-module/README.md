# WeChatBridge —— LSPosed 模块

微信侧的通道：读消息、发消息。思考全在 DSH 插件里。

## 结构

| 文件 | 作用 |
|---|---|
| `XposedInit.java` | 入口，日志同时走 logcat / XposedBridge / 远程 `/api/log` |
| `Hooks.java` | 组装：BridgeClient + DbHook + 发送出口 |
| `DbHook.java` | 收消息：Hook WCDB `SQLiteDatabase.insert` 系列，过滤 `message` 表 |
| `EmojiNames.java` | 表情包外显名字：拿 md5 查 `EmojiInfo` 表 |
| `BridgeClient.java` | HTTP 客户端 + 全局发送队列（串行、重试） |
| `WeChatSender.java` | 发消息：`y11.s1.a(talker)` 造实体 → 入队 |
| `RemoteLog.java` | 把日志批量推回插件，方便在手机上看 |
| `UpdateBlocker.java` | 拦更新提示 |

## 构建

```bash
bash tools/build-apk.sh
# build/manual/wechat-bridge-<VERSION>.apk
```

只依赖 `javac`、`d8`(r8)、`aapt`、`zipalign`、`apksigner`，不需要 Android Studio。
版本号在 `VERSION` / `VERSION_CODE` 两个文件里。

## 适配别的微信版本

混淆符号（`y11.s1`、`y11.r1`、`e01.e2`）每个版本都会变。收消息走 WCDB 一般不受影响；发消息要重新定位，方法见仓库根目录 `docs/04-wechat-8076.md`。
