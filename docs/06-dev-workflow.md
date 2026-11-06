# 开发流程

没有 Android Studio，全部在手机上用命令行构建。改动分三条路径，生效方式各不相同。

## 改插件代码（`lib/`）

```bash
cd ~/.dsh/dsh-go/plugins/local-wechat-bridge
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load
```

检查器通过（所有面板都能渲染）后，**重启一次引擎**才生效。

## 改插件清单（`package.json`）

面板的 id、标题、座位改动，宿主自动重载，**不用重启**；气泡/胶囊如果还显示，强制关闭 App 再开。

## 改 LSPosed 模块（Java）

```bash
cd /root/workspace/wechat-lsposed-module
# 改 VERSION / VERSION_CODE 让版本可辨认
bash tools/build-apk.sh
```

产物 `build/manual/wechat-bridge-<版本>.apk`，脚本会自动复制到 `/sdcard/Download/DSHGO/`。
安装后要**强制停止微信再打开**，主进程才会重新加载模块。

## 验证闭环

1. 模块日志：插件 `data/bridge.log` 里应有 `com.tencent.mm | WeChatBridge <版本> 启动`
2. 发一条消息，看模块是否上报（`收到 private 消息 ...`）
3. 看插件是否回复（`reply.out`，面板今日消息数 +1）
4. 微信里确认消息出现、是 `isSend=1 type=1`

失败先看日志的 `denied`（白名单）、`model failed`（模型）、`桥接不可用`（引擎没起）。

## 已踩过的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 主进程没注入 | 只重启了 App 没强停 | 强制停止微信 |
| 发送日志成功但消息不可见 | 类型字段写了 0 | 用 `e01.e2.C(talker)` |
| `ClassNotFoundException: y11.s1` | 用模块自己的 ClassLoader | 用 `lpparam.classLoader` |
| 同一条消息回两次 | 多个 insert 方法重复触发 | 10 秒去重表 |
| 白名单里加了聊天对象却仍被拒 | 比对的是**发送者** wxid | 群里加成员 wxid |
| 面板点动作没反应 | 插件没重启 | 重启引擎 |
| 选模型后 bot 沉默 | `provider/model` 写错 | 面板选模型会先探测，看报错 |

## 交付位置

| 内容 | 路径 |
|---|---|
| APK | `/sdcard/Download/DSHGO/wechat-bridge-<版本>.apk` |
| 文档副本 | `/sdcard/Download/DSHGO/docs/` |
| 模块源码 | `/root/workspace/wechat-lsposed-module/` |
| 插件源码 | `~/.dsh/dsh-go/plugins/local-wechat-bridge/` |
