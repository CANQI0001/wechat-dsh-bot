package com.dsh.wechatbridge;

import android.os.Handler;
import android.os.Looper;

import java.lang.reflect.Field;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

import de.robv.android.xposed.XposedHelpers;

/**
 * 发消息出口。
 *
 * 8.0.76 里能发文本的候选都是**实例方法**，没有现成静态入口：
 *   kl5.s5#qj(String talker, String content)       ← 首选
 *   kl5.s5#mj / #nj
 *   rr1.a#a(String, String)
 *
 * 所以我们不等它自己出现，而是在 {@link SendProbe} 里 Hook 这些方法，
 * 一旦你手动发过一次消息，就把当时的实例抓下来存着，之后复用同一个实例
 * 调 qj 发文本。
 *
 * 这是「借真实实例」的做法：不 new、不猜构造参数，风险最小。
 */
public final class WeChatSender implements BridgeClient.ReplySink {

    private static final Map<String, Object> INSTANCES = new ConcurrentHashMap<>();
    private static final Map<String, Integer> HITS = new ConcurrentHashMap<>();
    private static volatile String preferred = "uk#clone";
    private static final AtomicBoolean SELF_TEST_DONE = new AtomicBoolean();
    /** 微信的类加载器：y11/ pt1 这些混淆类只能在这里找。 */
    private static volatile ClassLoader hostLoader;

    public static void captureInstance(String key, Object instance) {
        if (instance == null) return;
        INSTANCES.putIfAbsent(key, instance);
        HITS.merge(key, 1, Integer::sum);
        if (HITS.get(key) == 1) {
            XposedInit.log("已抓到发送实例 " + key + " -> " + instance.getClass().getName());

        }
    }

    /** 抓到发送实例后，立刻回一条测试消息，验证发送链路。 */
    private static void selfTest(Object uk) {
        if (!SELF_TEST_DONE.compareAndSet(false, true)) return;
        try {
            Object talker = getField(uk, "e");
            if (talker == null) return;
            String target = String.valueOf(talker);
            XposedInit.log("自检：向 " + target + " 发一条测试消息");
            new Handler(Looper.getMainLooper()).postDelayed(() -> sendText(target, "小鱼上线测试 ✅"), 1500);
        } catch (Throwable t) {
            XposedInit.log("自检失败：" + t);
        }
    }

    private static Object getField(Object obj, String name) {
        Class<?> type = obj.getClass();
        while (type != null && type != Object.class) {
            try {
                Field f = type.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(obj);
            } catch (NoSuchFieldException ignored) {
                type = type.getSuperclass();
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    @Override
    public boolean send(String sessionId, String chatType, String text) {
        XposedInit.log("准备发送 -> " + sessionId + " : " + text);
        boolean ok = sendText(sessionId, text);
        XposedInit.log(ok ? "已发出" : "这次没发出去");
        return ok;
    }

    /**
     * 需要先在微信里手动发过一次消息，让 SendProbe 抓到实例。
     */
    private static boolean sendText(final String talker, final String text) {
        if (talker == null || talker.isEmpty() || text == null || text.isEmpty()) return false;

        // 首选：直接按 uk#run 的字节码复刻，无需 UI 实例
        if (sendViaEntity(talker, text)) return true;

        // 次选：克隆一个发送 Runnable（uk）
        if (sendViaClone(talker, text)) return true;

        // 次选：聊天组件 tk#o0(talker, type, content)
        Object tk = INSTANCES.get("tk");
        if (tk != null) {
            try {
                Object result = XposedHelpers.callMethod(tk, "o0", talker, 1, text);
                if (!(result instanceof Boolean) || (Boolean) result) {
                    XposedInit.log("用 tk#o0 发送成功：" + talker);
                    return true;
                }
                XposedInit.log("tk#o0 返回 false：" + talker);
            } catch (Throwable t) {
                XposedInit.log("tk#o0 调用失败：" + t);
            }
        }

        // 按优先级依次尝试已抓到的实例
        for (String key : new String[]{"kl5.s5", "rr1.a"}) {
            Object instance = INSTANCES.get(key);
            if (instance == null) continue;
            for (String method : key.equals("kl5.s5")
                    ? new String[]{"qj", "mj", "nj"}
                    : new String[]{"a"}) {
                try {
                    Object result = XposedHelpers.callMethod(instance, method, talker, text);
                    if (result == null || result instanceof Boolean) {
                        if (!(result instanceof Boolean) || (Boolean) result) {
                            preferred = key + "#" + method;
                            XposedInit.log("用 " + preferred + " 发送成功：" + talker);
                            return true;
                        }
                    }
                } catch (Throwable t) {
                    // 参数个数/类型不匹配时换下一个
                    if (method.equals("nj") || method.equals("mj")) {
                        continue;
                    }
                    XposedInit.log(key + "#" + method + " 调用失败：" + t);
                }
            }
        }
        return false;
    }

    /**
     * 直接复刻微信自己的发送流程（来自 uk#run 的字节码）：
     *
     *   r1 msg = y11.s1.a(toUser)
     *   msg.e = 1            // 消息类型 TEXT
     *   msg.f = 0
     *   msg.e(content)       // 内容
     *   msg.g(toUser)        // 对方
     *   n1 = msg.a()         // 组包
     *   n1.a()               // 发出
     */
    private static boolean sendViaEntity(String talker, String text) {
        try {
            ClassLoader loader = hostLoader;
            if (loader == null) return false;
            Class<?> s1 = XposedHelpers.findClass("y11.s1", loader);
            Class<?> r1 = XposedHelpers.findClass("y11.r1", loader);
            Object msg = XposedHelpers.callStaticMethod(s1, "a", talker);
            if (msg == null) return false;
            // e = 消息类型：和微信一样用 e01.e2.C(talker) 算（普通/群聊都是 1 = 文本）
            int msgType = 1;
            try {
                msgType = (Integer) XposedHelpers.callStaticMethod(
                        XposedHelpers.findClass("e01.e2", loader), "C", talker);
            } catch (Throwable ignored) {
            }
            XposedHelpers.setIntField(msg, "e", msgType);
            XposedHelpers.setIntField(msg, "f", 0);
            XposedHelpers.setIntField(msg, "i", 5);
            XposedHelpers.callMethod(msg, "e", text);
            XposedHelpers.callMethod(msg, "g", talker);
            Object n1 = XposedHelpers.callMethod(msg, "a");
            if (n1 == null) return false;
            Object result = XposedHelpers.callMethod(n1, "a");
            boolean ok = !(result instanceof Boolean) || (Boolean) result;
            XposedInit.log("实体发送 " + (ok ? "成功" : "返回 false") + " -> " + talker);
            return ok;
        } catch (Throwable t) {
            XposedInit.log("实体发送失败：" + t);
            return false;
        }
    }

    /**
     * 用抓到的 uk 实例当模板，克隆一个新实例（换 talker/content），再执行 run()。
     *
     * 构造参数顺序与字段一一对应：
     * (tk, Z d, String e=talker, y3 f, String g=content, Z h, String i, String m,
     *  String n=content, I o, Map p, String q, f4 r, Context s)
     */
    private static boolean sendViaClone(String talker, String text) {
        Object uk = INSTANCES.get("uk");
        if (uk == null) return sendWithoutTemplate(talker, text);
        try {
            Class<?> clazz = uk.getClass();
            Object[] args = {
                    getField(uk, "t"),   // tk
                    getField(uk, "d"),   // Z
                    talker,              // e = talker
                    getField(uk, "f"),   // y3
                    text,                // g = content
                    getField(uk, "h"),   // Z
                    getField(uk, "i"),
                    getField(uk, "m"),
                    text,                // n = content
                    getField(uk, "o"),   // I
                    getField(uk, "p"),   // Map
                    getField(uk, "q"),
                    getField(uk, "r"),   // f4
                    getField(uk, "s"),   // Context
            };
            Object clone = XposedHelpers.newInstance(clazz, args);
            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    XposedHelpers.callMethod(clone, "run");
                } catch (Throwable t) {
                    XposedInit.log("克隆任务执行失败：" + t);
                }
            });
            XposedInit.log("用 uk 克隆发送 -> " + talker + " : " + text);
            return true;
        } catch (Throwable t) {
            XposedInit.log("克隆发送失败：" + t);
            return false;
        }
    }

    /**
     * 没有抓到 uk 模板时的兜底：用抓到的聊天组件 tk + 空的其他参数，直接构造一个。
     * f(y3) 和 r(f4) 允许为 null，run() 里如果不用就不会炸。
     */
    private static boolean sendWithoutTemplate(String talker, String text) {
        Object tk = INSTANCES.get("tk");
        if (tk == null) return false;
        try {
            ClassLoader loader = tk.getClass().getClassLoader();
            Class<?> ukClass = XposedHelpers.findClass("com.tencent.mm.ui.chatting.component.uk", loader);
            Object context = null;
            try {
                context = de.robv.android.xposed.XposedHelpers.callStaticMethod(
                        XposedHelpers.findClass("android.app.AndroidAppHelper", loader),
                        "currentApplication");
            } catch (Throwable ignored) {
            }
            Object[] args = {
                    tk, false, talker, null, text, false, "", "", text, 0, null, null, null, context,
            };
            Object instance = XposedHelpers.newInstance(ukClass, args);
            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    XposedHelpers.callMethod(instance, "run");
                } catch (Throwable t) {
                    XposedInit.log("兜底任务执行失败：" + t);
                }
            });
            XposedInit.log("用兜底模板发送 -> " + talker + " : " + text);
            return true;
        } catch (Throwable t) {
            XposedInit.log("兜底模板构造失败：" + t);
            return false;
        }
    }

    /** 由 Hooks 在注入时调用，记下微信的类加载器。 */
    public static void bindClassLoader(ClassLoader loader) {
        hostLoader = loader;
    }

    public static String status() {
        if (INSTANCES.isEmpty()) return "未抓到发送实例";
        StringBuilder sb = new StringBuilder("已抓: ");
        for (String key : INSTANCES.keySet()) sb.append(key).append(" x").append(HITS.get(key)).append(" ");
        return sb.toString().trim();
    }
}
