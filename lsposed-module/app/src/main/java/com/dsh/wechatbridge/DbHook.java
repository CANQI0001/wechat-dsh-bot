package com.dsh.wechatbridge;

import android.content.ContentValues;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * 收消息 Hook —— 走数据库这一层。
 *
 * 为什么不用微信自己的类名：8.x 把 com.tencent.mm.storage 整个混淆成短名
 * （8.0.76 里消息实体是 y11.r1、发送场景是 pt1.g），每个版本都变。
 * 但 WCDB 是腾讯自己的 SDK，类名稳定，且所有消息落库都经过它：
 *
 *   SQLiteDatabase.insert / insertWithOnConflict / replace
 *       (table, nullColumnHack, ContentValues)
 *
 * 表名 "message" 和列名（talker/content/isSend/type/createTime…）是 schema，
 * 跨版本基本不变，所以这比 Hook 业务类稳。
 *
 * 只处理 isSend = 0（别人发来的）。自己发的、发送回执都跳过。
 */
public final class DbHook {

    private static final String TABLE_MESSAGE = "message";
    private static int seen = 0;
    private static final Map<String, Long> RECENT = new ConcurrentHashMap<>();

    private final BridgeClient client;

    public DbHook(BridgeClient client) {
        this.client = client;
    }

    public void install(XC_LoadPackage.LoadPackageParam lpparam) {
        String wcdb = "com.tencent.wcdb.database.SQLiteDatabase";
        hookInsert(lpparam.classLoader, wcdb, "insert");
        hookInsert(lpparam.classLoader, wcdb, "insertWithOnConflict");
        hookInsert(lpparam.classLoader, wcdb, "insertOrThrow");
        hookInsert(lpparam.classLoader, wcdb, "replace");
        hookInsert(lpparam.classLoader, wcdb, "replaceOrThrow");
        XposedInit.log("收消息 Hook：WCDB 数据库层已挂");
    }

    private void hookInsert(ClassLoader loader, String className, String methodName) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllMethods(clazz, methodName, new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    try {
                        EmojiNames.bind(param.thisObject); // 留一个数据库句柄查表情名字
                        handle(param.args);
                    } catch (Throwable t) {
                        XposedInit.log("数据库消息解析失败：" + t);
                    }
                }
            });
        } catch (Throwable t) {
            XposedInit.log("Hook " + className + "#" + methodName + " 失败：" + t);
        }
    }

    private void handle(Object[] args) {
        if (args == null || args.length < 3) return;
        if (!(args[0] instanceof String) || !(args[2] instanceof ContentValues)) return;
        if (!TABLE_MESSAGE.equals(args[0])) return;

        ContentValues cv = (ContentValues) args[2];
        Integer isSend = cv.getAsInteger("isSend");
        if (seen < 10) {
            seen++;
            XposedInit.log("DB 插入 message: isSend=" + isSend + " type=" + cv.getAsInteger("type")
                    + " talker=" + cv.getAsString("talker"));
        }
        if (isSend != null && isSend != 0) return;

        String talker = cv.getAsString("talker");
        String content = cv.getAsString("content");
        if (talker == null || content == null || content.isEmpty()) return;
        if (talker.startsWith("gh_") || "filehelper".equals(talker)) return;

        Integer type = cv.getAsInteger("type");
        boolean isText = type == null || type == 1;
        // 非文本消息也回：表情包 / 图片 / 语音等转成占位文字给模型
        String placeholder = isText ? null : typeLabel(type, content);
        if (!isText && placeholder == null) return;

        Long createTime = cv.getAsLong("createTime");
        // 同一条消息可能被多个 insert 方法重复触发，按 (talker, 内容, 时间) 去重
        String dedupeKey = talker + "|" + content + "|" + createTime;
        long now = System.currentTimeMillis();
        Long last = RECENT.put(dedupeKey, now);
        if (RECENT.size() > 200) {
            RECENT.entrySet().removeIf(e -> now - e.getValue() > 60_000L);
        }
        if (last != null && now - last < 10_000L) return;
        String text = isText ? normalize(content) : placeholder;
        if (text == null || text.isEmpty()) return;

        WeChatMessage msg = new WeChatMessage();
        msg.msgId = "db-" + (createTime == null ? System.currentTimeMillis() : createTime)
                + "-" + UUID.randomUUID().toString().substring(0, 8);
        msg.sessionId = talker;
        msg.isGroup = talker.endsWith("@chatroom");
        msg.chatType = msg.isGroup ? "group" : "private";
        msg.content = text;
        msg.msgType = "text";
        msg.rawType = type == null ? 1 : type;
        msg.timestamp = createTime == null ? System.currentTimeMillis() / 1000L : normalizeTime(createTime);
        msg.groupId = msg.isGroup ? talker : null;
        msg.groupName = msg.isGroup ? talker : null;
        msg.atMe = msg.isGroup && content.contains("@");
        msg.senderId = extractSender(content, talker);
        msg.senderName = "";

        if (msg.isGroup && !msg.atMe) return; // 群里没 @ 不回

        XposedInit.log("收到 " + msg.chatType + " 消息 " + msg.sessionId);
        client.submitAsync(msg);
    }

    /**
     * 非文本消息的占位文字。我们没有识图能力，所以只告诉模型「对方发了什么」，
     * 让它自然接一句，而不是去描述内容。
     */
    private static String typeLabel(Integer type, String content) {
        if (type == null) return null;
        switch (type) {
            case 3:  return "[图片]";
            case 47: {
                // 表情包尽量带上外显名字，模型好接话；查不到就退回 [表情]
                String name = EmojiNames.lookup(extractMd5(content));
                return name == null || name.isEmpty() ? "[表情]" : "[表情: " + name + "]";
            }
            case 34: return "[语音]";
            case 43: return "[视频]";
            case 42: return "[名片]";
            case 48: return "[位置]";
            case 49: return "[链接或文件]";
            default: return null;
        }
    }

    /** 表情 XML 里的 md5 属性。 */
    private static String extractMd5(String content) {
        if (content == null) return null;
        int i = content.indexOf("md5=\"");
        if (i < 0) return null;
        int start = i + 5;
        int end = content.indexOf('"', start);
        if (end <= start) return null;
        String md5 = content.substring(start, end).trim();
        return md5.length() >= 16 ? md5 : null;
    }

    /** 群聊的 content 形如 "wxid_xxx:\n正文"。 */
    private static String extractSender(String raw, String talker) {
        int colon = raw.indexOf(":\n");
        if (colon > 0 && colon < 64) return raw.substring(0, colon);
        return talker.endsWith("@chatroom") ? "" : talker;
    }

    /** 去掉群聊前缀 / XML 包装，只留可读文本。 */
    private static String normalize(String content) {
        String text = content;
        if (text.startsWith("<")) {
            int s = text.indexOf("<title>");
            int e = text.indexOf("</title>");
            if (s >= 0 && e > s) text = text.substring(s + 7, e);
            else return "";
        }
        int colon = text.indexOf(":\n");
        if (colon > 0 && colon < 64) text = text.substring(colon + 2);
        return text.trim();
    }

    private static long normalizeTime(long raw) {
        return raw > 10_000_000_000L ? raw / 1000L : raw;
    }
}
