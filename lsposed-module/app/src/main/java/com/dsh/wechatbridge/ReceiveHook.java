package com.dsh.wechatbridge;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.UUID;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;

/**
 * 收消息 Hook。
 *
 * 微信的消息对象字段名随版本变化，所以这里用「按类型找字段」的宽容策略：
 * 从 Hook 到的消息对象里，把 String 字段找出来，按语义猜测：
 *  - 8~32 位、以 wxid_ / @chatroom 结尾的 → talker / sessionId
 *  - 最长的中文文本 → content
 * 这样即使字段名变了，多数版本仍能工作；字段名明确后可以改成精确取值。
 */
public final class ReceiveHook {

    private final BridgeClient client;

    public ReceiveHook(BridgeClient client) {
        this.client = client;
    }

    void attach(ClassLoader loader, String className, String methodName) {
        Class<?> clazz = XposedHelpers.findClass(className, loader);
        java.util.Set<XC_MethodHook.Unhook> unhooks =
                XposedBridge.hookAllMethods(clazz, methodName, new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        try {
                            Object msg = pickMessageObject(param.args);
                            if (msg == null) return;
                            WeChatMessage parsed = parse(msg);
                            if (parsed == null || parsed.content.isEmpty()) return;
                            XposedInit.log("收到 " + parsed.chatType + " 消息 -> " + parsed.sessionId);
                            client.submitAsync(parsed);
                        } catch (Throwable t) {
                            XposedInit.log("解析消息失败：" + t);
                        }
                    }
                });
        if (unhooks == null || unhooks.isEmpty()) {
            throw new IllegalStateException("没找到可 Hook 的 " + methodName + " 重载");
        }
    }

    /** 从参数里挑出最像「消息」的对象：字段最多的那个。 */
    private static Object pickMessageObject(Object[] args) {
        Object best = null;
        int bestScore = 0;
        for (Object arg : args) {
            if (arg == null) continue;
            int score = countStringFields(arg.getClass());
            if (score > bestScore) {
                bestScore = score;
                best = arg;
            }
        }
        return bestScore >= 2 ? best : null;
    }

    private static int countStringFields(Class<?> type) {
        int n = 0;
        for (Field f : type.getDeclaredFields()) {
            if (f.getType() == String.class) n++;
        }
        return n;
    }

    /** 宽容解析：把 String 字段归类成 talker / content / 发送者。 */
    private static WeChatMessage parse(Object msg) {
        Class<?> type = msg.getClass();
        String talker = null;
        String content = null;
        String selfId = null;
        long createTime = 0;

        for (Field f : type.getDeclaredFields()) {
            try {
                f.setAccessible(true);
                String name = f.getName().toLowerCase();
                if (f.getType() == String.class) {
                    String value = (String) f.get(msg);
                    if (value == null || value.isEmpty()) continue;
                    if (name.contains("talker") || name.contains("username") || name.contains("session")) {
                        talker = value;
                    } else if (name.contains("content") || name.contains("msg")) {
                        if (content == null || value.length() > content.length()) content = value;
                    } else if (value.startsWith("wxid_")) {
                        if (selfId == null) selfId = value;
                    } else if (looksLikeChatId(value) && talker == null) {
                        talker = value;
                    }
                } else if (f.getType() == long.class && (name.contains("time") || name.contains("create"))) {
                    long v = f.getLong(msg);
                    if (v > createTime) createTime = v;
                }
            } catch (Throwable ignored) {
                // 某些字段反射受限，跳过
            }
        }

        if (talker == null || content == null) return null;

        WeChatMessage out = new WeChatMessage();
        out.msgId = UUID.randomUUID().toString();
        out.sessionId = talker;
        out.isGroup = talker.endsWith("@chatroom");
        out.chatType = out.isGroup ? "group" : "private";
        out.content = stripXmlNoise(content);
        out.msgType = "text";
        out.timestamp = createTime > 0 ? normalizeTimestamp(createTime) : System.currentTimeMillis() / 1000L;
        out.groupId = out.isGroup ? talker : null;
        // 发送者：群聊里需要从 content 的 wxid 前缀或额外字段拿，先留空由 DSH 侧放宽
        out.senderId = out.isGroup ? "" : talker;
        out.senderName = "";
        return out;
    }

    private static boolean looksLikeChatId(String value) {
        return value.endsWith("@chatroom") || value.startsWith("wxid_") || value.matches("\\d+@chatroom");
    }

    private static long normalizeTimestamp(long raw) {
        // 微信时间戳是毫秒；有的版本是秒
        return raw > 10_000_000_000L ? raw / 1000L : raw;
    }

    /** 文本消息可能带 XML 包装（图片/链接），只保留可读文本。 */
    private static String stripXmlNoise(String content) {
        String trimmed = content.trim();
        if (!trimmed.startsWith("<")) return trimmed;
        int titleStart = trimmed.indexOf("<title>");
        int titleEnd = trimmed.indexOf("</title>");
        if (titleStart >= 0 && titleEnd > titleStart) {
            return trimmed.substring(titleStart + 7, titleEnd).trim();
        }
        return "";
    }
}
