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
    private static int IMG_PROBE = 0;

    /** 等 imgPath 补上来的图片消息 */
    private static final Map<String, PendingImage> PENDING_IMAGES = new ConcurrentHashMap<>();
    private static final java.util.concurrent.ScheduledExecutorService IMG_TIMER =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "wxbridge-img");
                t.setDaemon(true);
                return t;
            });

    private static final class PendingImage {
        final WeChatMessage msg;
        final Object db;
        final long at = System.currentTimeMillis();

        PendingImage(WeChatMessage msg, Object db) {
            this.msg = msg;
            this.db = db;
        }
    }
    private static final Map<String, Long> RECENT = new ConcurrentHashMap<>();

    private final BridgeClient client;
    private static volatile Object currentDb;

    private static volatile DbHook INSTANCE;

    public DbHook(BridgeClient client) {
        this.client = client;
        INSTANCE = this;
    }

    public void install(XC_LoadPackage.LoadPackageParam lpparam) {
        String wcdb = "com.tencent.wcdb.database.SQLiteDatabase";
        hookInsert(lpparam.classLoader, wcdb, "insert");
        hookInsert(lpparam.classLoader, wcdb, "insertWithOnConflict");
        hookInsert(lpparam.classLoader, wcdb, "insertOrThrow");
        hookInsert(lpparam.classLoader, wcdb, "replace");
        hookInsert(lpparam.classLoader, wcdb, "replaceOrThrow");
        hookUpdate(lpparam.classLoader, wcdb);
        // 图片没等到 update 时也要每秒看一眼：缩略图落盘是异步的
        IMG_TIMER.scheduleWithFixedDelay(DbHook::sweepPending, 1, 1, java.util.concurrent.TimeUnit.SECONDS);
        XposedInit.log("收消息 Hook：WCDB 数据库层已挂");
    }

    /** 图片下载完微信会 UPDATE 这一行，把 imgPath 写进去。 */
    private void hookUpdate(ClassLoader loader, String className) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllMethods(clazz, "update", new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    try {
                        if (param.args.length < 1 || !(param.args[0] instanceof String)) return;
                        String table = (String) param.args[0];
                        if (!TABLE_MESSAGE.equals(table) && !"ImgInfo2".equals(table)) return;
                        currentDb = param.thisObject;
                        if (PENDING_IMAGES.isEmpty()) return;
                        // 别在数据库线程里直接查，挪到自己的线程，1 秒后再扫
                        IMG_TIMER.schedule(DbHook::sweepPending, 1, java.util.concurrent.TimeUnit.SECONDS);
                    } catch (Throwable t) {
                        XposedInit.log("图片 update 处理失败：" + t);
                    }
                }
            });
        } catch (Throwable t) {
            XposedInit.log("Hook " + className + "#update 失败：" + t);
        }
    }

    /** 这个会话还有图片在等原图？有的话入站缓冲要等它一起。 */
    public static boolean hasPendingImage(String sessionId) {
        if (sessionId == null) return false;
        for (PendingImage p : PENDING_IMAGES.values()) {
            if (sessionId.equals(p.msg.sessionId)) return true;
        }
        return false;
    }

    private static void sweepPending() {
        for (String msgId : PENDING_IMAGES.keySet()) {
            resolvePending(msgId);
        }
        // 超过 40 秒还没等到就放弃，按占位交付
        long now = System.currentTimeMillis();
        PENDING_IMAGES.forEach((id, p) -> {
            if (now - p.at > 40_000L) deliverPending(id, false);
        });
    }

    private static void resolvePending(String msgId) {
        PendingImage pending = PENDING_IMAGES.get(msgId);
        if (pending == null) return;
        String raw = DbQuery.column(pending.db, "SELECT imgPath FROM message WHERE msgId = ?", msgId, "imgPath");
        if (raw == null || raw.isEmpty()) {
            raw = DbQuery.column(pending.db, "SELECT bigImgPath FROM message WHERE msgId = ?", msgId, "bigImgPath");
        }
        if (raw == null || raw.isEmpty()) {
            // 8.x 把图片路径放在 ImgInfo2 表里，列名随版本变，所以整行读出来挑
            java.util.Map<String, String> info = DbQuery.row(pending.db, "SELECT * FROM ImgInfo2 WHERE msgId = ?", msgId);
            if (info == null) info = DbQuery.row(pending.db, "SELECT * FROM ImgInfo WHERE msgId = ?", msgId);
            if (info == null && IMG_PROBE < 5) {
                IMG_PROBE++;
                java.util.Map<String, String> tables = DbQuery.row(pending.db,
                        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", "ImgInfo2");
                XposedInit.log("ImgInfo2 行查不到（tables 探测：" + tables + "）");
            }
            if (info != null) {
                for (Map.Entry<String, String> e : info.entrySet()) {
                    String key = e.getKey().toLowerCase();
                    String val = e.getValue();
                    if (key.equals("msgid")) continue;
                    if (key.contains("path") && (val.contains("://") || val.startsWith("/"))) {
                        raw = val;
                        XposedInit.log("图片路径来自 " + e.getKey() + "：" + val);
                        break;
                    }
                }
                if (raw == null || raw.isEmpty()) {
                    if (IMG_PROBE < 6) {
                        IMG_PROBE++;
                        XposedInit.log("ImgInfo2 有行但没有路径列：" + info.keySet());
                    }
                }
            }
        }
        String path = ImageUtil.resolvePath(raw);
        if (path == null) {
            // 不知道文件名规律就直接扫：挑最近的、能解码的那张
            String direct = ImageUtil.findRecentDecodable(pending.at - 5000L);
            if (direct != null) {
                pending.msg.imageBase64 = direct;
                pending.msg.imageMime = "image/jpeg";
                deliverPending(msgId, true);
            }
            return;
        }
        String b64 = ImageUtil.encodeSmall(path);
        if (b64 == null) return;
        pending.msg.imageBase64 = b64;
        pending.msg.imageMime = "image/jpeg";
        deliverPending(msgId, true);
    }

    /** 交付并移除；withImage=false 表示等超时了，只发占位。 */
    private static void deliverPending(String msgId, boolean withImage) {
        PendingImage pending = PENDING_IMAGES.remove(msgId);
        if (pending == null) return;
        XposedInit.log("图片消息：" + (withImage
                ? "已缩图 " + (pending.msg.imageBase64.length() / 1024) + "KB"
                : "等不到原图，按 [图片] 回"));
        DbHook self = INSTANCE;
        if (self != null) InboundBuffer.offer(self.client, pending.msg);
    }

    private void hookInsert(ClassLoader loader, String className, String methodName) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllMethods(clazz, methodName, new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    try {
                        EmojiNames.bind(param.thisObject); // 留一个数据库句柄查表情名字
                        currentDb = param.thisObject;
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
        if (!TABLE_MESSAGE.equals(args[0])) {
            String table = args[0].toString().toLowerCase();
            if (!PENDING_IMAGES.isEmpty() && table.contains("img")) {
                XposedInit.log("图片表写入：" + args[0]);
                sweepPending();
            }
            return;
        }

        ContentValues cv = (ContentValues) args[2];
        Integer isSend = cv.getAsInteger("isSend");
        if (seen < 3) {
            seen++;
            XposedInit.log("DB 插入 message: isSend=" + isSend + " type=" + cv.getAsInteger("type")
                    + " talker=" + cv.getAsString("talker"));
        }
        if (isSend != null && isSend != 0) {
            // 自己发出去的文本：给发送侧一个「确实入库了」的信号
            Integer t = cv.getAsInteger("type");
            if (t == null || t == 1) WeChatSender.confirmSent(cv.getAsString("content"));
            return;
        }

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
        String imageB64 = null;
        String contentHash = null;
        if (type != null && type == 3) {
            // 收到的图片：微信下载后会写 imgPath 列（也有叫 bigImgPath 的版本）
            String rawPath = cv.getAsString("imgPath");
            if (rawPath == null) rawPath = cv.getAsString("bigImgPath");
            if (rawPath == null) rawPath = cv.getAsString("imgpath");
            String imgPath = ImageUtil.resolvePath(rawPath);
            if (imageB64 == null) {
                // XML 里通常带 cdnthumbmd5 / md5，缓存文件就是按它命名的
                contentHash = extractAttr(content, "cdnthumbmd5");
                if (contentHash == null) contentHash = extractAttr(content, "md5");
                if (contentHash != null) {
                    String found = ImageUtil.findByHash(contentHash);
                    if (found != null) {
                        imageB64 = ImageUtil.encodeSmall(found);
                        XposedInit.log("图片消息：按 md5 找到缓存 " + found);
                    }
                }
                if (IMG_PROBE < 3) {
                    IMG_PROBE++;
                    XposedInit.log("图片 XML：" + (content.length() > 300 ? content.substring(0, 300) : content));
                }
            }
            if (imgPath != null && imageB64 == null) {
                imageB64 = ImageUtil.encodeSmall(imgPath);
                XposedInit.log("图片消息：" + (imageB64 == null
                        ? "读取失败 " + (rawPath == null ? "(无路径)" : rawPath)
                        : "已缩图 " + (imageB64.length() / 1024) + "KB"));
            } else if (IMG_PROBE < 3) {
                IMG_PROBE++;
                XposedInit.log("图片消息：insert 里没有路径，等下载完成后补（可用列：" + cv.keySet() + "）");
            }
        }
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
        if (imageB64 != null) {
            msg.imageBase64 = imageB64;
            msg.imageMime = "image/jpeg";
        }
        msg.senderName = "";

        if (msg.isGroup && !msg.atMe) return; // 群里没 @ 不回

        // createTime 是微信给消息打的时间；和当前时间差多少，就能看出是"微信晚写库"还是"消息本身晚到"
        long sentAt = createTime == null ? 0 : (normalizeTime(createTime) * 1000L);
        long lag = sentAt > 0 ? (System.currentTimeMillis() - sentAt) : -1;
        XposedInit.log("收到 " + msg.chatType + " 消息 " + msg.sessionId
                + (lag >= 0 ? "（比发送时间晚 " + (lag / 1000) + "s）" : ""));

        // 图片这条路要等 imgPath 补上来，先挂起；15 秒还没等到就按占位回
        String msgId = cv.getAsString("msgId");
        if (msg.rawType == 3 && imageB64 == null && msgId != null && !msgId.isEmpty()) {
            PENDING_IMAGES.put(msgId, new PendingImage(msg, currentDb));
            IMG_TIMER.schedule(() -> deliverPending(msgId, false), 15, java.util.concurrent.TimeUnit.SECONDS);
            resolvePending(msgId);
            return;
        }
        InboundBuffer.offer(client, msg);
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
                // 自定义表情包看不出内容，直接无视（不回）
                if (name == null || name.isEmpty() || name.contains("动画表情")) return "";
                return "[表情: " + name + "]";
            }
            case 34: return "[语音]";
            case 43: return "[视频]";
            case 42: return "[名片]";
            case 48: return "[位置]";
            case 49: return "[链接或文件]";
            default: return null;
        }
    }

    /** 按属性名取 XML 里的值，例如 cdnthumbmd5="abc"。 */
    private static String extractAttr(String content, String attr) {
        if (content == null) return null;
        int i = content.indexOf(attr + "=\"");
        if (i < 0) return null;
        int start = i + attr.length() + 2;
        int end = content.indexOf('"', start);
        if (end <= start) return null;
        String v = content.substring(start, end).trim();
        return v.length() >= 8 ? v : null;
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
