package com.dsh.wechatbridge;

import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicInteger;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * 发送链路的「取证」Hook（8.0.76 专用，只打日志，不改行为）。
 *
 * 8.0.76 里消息实体和发送工厂都被混淆了：
 *   - 消息实体：Ly11/r1   （builder 风格：e()/g()/h() 返回自身）
 *   - 发送工厂：Lpt1/g    （b/c/f/g/h/k/m 接收 r1，返回发送场景 Ly11/m1）
 *   - 发送管理：Lpt1/a、Lpt1/f
 *
 * 光看字节码猜不出哪个 setter 是 talker、哪个是 content，所以这里在运行时
 * 把对象字段全 dump 出来：你手动在微信里发一条「测试」，日志里就能看到
 * 真实字段名和值，然后 WeChatSender 照着填即可。
 *
 * 取证够了就关掉：把 ENABLED 改成 false。
 */
public final class SendProbe {

    private static final boolean ENABLED = false;
    private static final int MAX_DUMPS = 200;
    private static final AtomicInteger dumps = new AtomicInteger();

    private SendProbe() {
    }

    public static void install(XC_LoadPackage.LoadPackageParam lpparam) {
        if (!ENABLED) return;
        ClassLoader loader = lpparam.classLoader;

        // 传描述符，内部转成 XposedHelpers.findClass 要的点号形式
        hookFactory(loader, "Lpt1/g;");
        hookFactory(loader, "Lpt1/f;");
        hookFactory(loader, "Lpt1/a;");
        // 8.0.76 的「发文本」候选：都是实例方法，顺手把实例抓下来给 WeChatSender 复用
        hookSendText(loader, "kl5.s5", "qj");
        hookSendText(loader, "kl5.s5", "mj");
        hookSendText(loader, "kl5.s5", "nj");
        hookSendText(loader, "rr1.a", "a");
        // 兜底：这两个类不管调哪个方法，都把实例抓下来
        captureAllMethods(loader, "kl5.s5");
        captureAllMethods(loader, "rr1.a");
        traceMessageEntity(loader, "y11.r1");
        traceFactory(loader, "y11.s1");
        // 真正的发送入口：聊天组件 tk#o0(String, int, String)Z，内部创建 uk#run
        hookChatSend(loader, "com.tencent.mm.ui.chatting.component.tk", "o0");
        // 真正执行发送的 Runnable
        hookSenderRunnable(loader, "com.tencent.mm.ui.chatting.component.uk");
        captureTkComponent(loader, "com.tencent.mm.ui.chatting.component.tk");
        XposedInit.log("发送取证 Hook 已挂（手动发一条微信触发）");
    }

    private static void hookFactory(ClassLoader loader, String descriptor) {
        String className = dotted(descriptor);
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllMethods(clazz, "f", new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    capture(className + "#f(before)", param.args, param.thisObject);
                }

                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    capture(className + "#f(after)", param.args, null);
                }
            });
            XposedBridge.hookAllMethods(clazz, "b", new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    capture(className + "#b", param.args, param.thisObject);
                }
            });
        } catch (Throwable t) {
            XposedInit.log("取证 Hook 装不上 " + className + "：" + t);
        }
    }

    /** 抓发送入口的实例 + 打参数日志。 */
    private static void hookSendText(ClassLoader loader, String className, String methodName) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllMethods(clazz, methodName, new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    WeChatSender.captureInstance(className, param.thisObject);
                    capture("发送候选 " + className + "#" + methodName, param.args, null);
                }
            });
        } catch (Throwable t) {
            XposedInit.log("发送候选装不上 " + className + "#" + methodName + "：" + t);
        }
    }

    /** 消息实体：哪个 setter 被调用、传了什么，直接打出来。 */
    private static void traceMessageEntity(ClassLoader loader, String className) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            int hooked = 0;
            for (java.lang.reflect.Method method : clazz.getDeclaredMethods()) {
                if (method.getParameterCount() > 2) continue;
                try {
                    XposedBridge.hookMethod(method, new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            if (dumps.get() >= MAX_DUMPS) return;
                            StringBuilder sb = new StringBuilder("实体调用 ")
                                    .append(method.getName()).append("(");
                            Object[] args = param.args;
                            for (int i = 0; i < args.length; i++) {
                                if (i > 0) sb.append(", ");
                                String v = String.valueOf(args[i]);
                                sb.append(v.length() > 60 ? v.substring(0, 60) + "…" : v);
                            }
                            sb.append(") @ ").append(stackTop());
                            XposedInit.log(sb.toString());
                        }
                    });
                    hooked++;
                } catch (Throwable ignored) {
                }
            }
            XposedInit.log("消息实体追踪 " + className + " 挂了 " + hooked + " 个方法");
        } catch (Throwable t) {
            XposedInit.log("消息实体追踪装不上 " + className + "：" + t);
        }
    }

    /** 聊天组件：构造函数一跑就抓实例，打开任意聊天即可。 */
    private static void captureTkComponent(ClassLoader loader, String className) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllConstructors(clazz, new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    WeChatSender.captureInstance("tk", param.thisObject);
                }
            });
            XposedInit.log("聊天组件抓取已挂 " + className);
        } catch (Throwable t) {
            XposedInit.log("聊天组件抓取装不上：" + t);
        }
    }

    /** 发送 Runnable：抓实例 + 打印它带着的字段（找出 talker/content）。 */
    private static void hookSenderRunnable(ClassLoader loader, String className) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllMethods(clazz, "run", new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    Object self = param.thisObject;
                    if (self == null) return;
                    WeChatSender.captureInstance("uk", self);
                    if (dumps.get() >= MAX_DUMPS) return;
                    StringBuilder sb = new StringBuilder("发送 Runnable 字段:");
                    Class<?> type = self.getClass();
                    while (type != null && type != Object.class) {
                        for (java.lang.reflect.Field f : type.getDeclaredFields()) {
                            if (!f.getType().equals(String.class) && !f.getType().equals(int.class)) continue;
                            try {
                                f.setAccessible(true);
                                Object v = f.get(self);
                                String text = String.valueOf(v);
                                if (text.length() > 50) text = text.substring(0, 50) + "…";
                                sb.append(" ").append(f.getName()).append("=").append(text);
                            } catch (Throwable ignored) {
                            }
                        }
                        type = type.getSuperclass();
                    }
                    XposedInit.log(sb.toString());
                }
            });
            XposedInit.log("发送 Runnable Hook 已挂 " + className + "#run");
        } catch (Throwable t) {
            XposedInit.log("发送 Runnable Hook 装不上：" + t);
        }
    }

    /** 聊天组件的发送函数：抓实例 + 打参数顺序。 */
    private static void hookChatSend(ClassLoader loader, String className, String methodName) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            XposedBridge.hookAllMethods(clazz, methodName, new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    WeChatSender.captureInstance("tk", param.thisObject);
                    StringBuilder sb = new StringBuilder("聊天发送 ").append(methodName).append("(");
                    Object[] args = param.args;
                    for (int i = 0; i < args.length; i++) {
                        if (i > 0) sb.append(", ");
                        sb.append(args[i] == null ? "null" : String.valueOf(args[i]));
                    }
                    sb.append(") @ ").append(stackTop());
                    XposedInit.log(sb.toString());
                }
            });
            XposedInit.log("聊天发送 Hook 已挂 " + className + "#" + methodName);
        } catch (Throwable t) {
            XposedInit.log("聊天发送 Hook 装不上：" + t);
        }
    }

    /** 消息工厂（静态方法）：打出入参和返回值。 */
    private static void traceFactory(ClassLoader loader, String className) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            for (java.lang.reflect.Method method : clazz.getDeclaredMethods()) {
                try {
                    XposedBridge.hookMethod(method, new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            StringBuilder sb = new StringBuilder("工厂 ")
                                    .append(method.getName()).append("(");
                            Object[] args = param.args;
                            for (int i = 0; i < args.length; i++) {
                                if (i > 0) sb.append(", ");
                                String v = String.valueOf(args[i]);
                                sb.append(v.length() > 40 ? v.substring(0, 40) + "…" : v);
                            }
                            sb.append(") -> ").append(param.getResult()).append(" @ ").append(stackTop());
                            XposedInit.log(sb.toString());
                        }
                    });
                } catch (Throwable ignored) {
                }
            }
            XposedInit.log("工厂追踪 " + className + " 已挂");
        } catch (Throwable t) {
            XposedInit.log("工厂追踪装不上 " + className + "：" + t);
        }
    }

    /** 不挑方法：这个类的方法一被调用就抓实例。 */
    private static void captureAllMethods(ClassLoader loader, String className) {
        try {
            Class<?> clazz = XposedHelpers.findClass(className, loader);
            int hooked = 0;
            for (java.lang.reflect.Method method : clazz.getDeclaredMethods()) {
                try {
                    XposedBridge.hookMethod(method, new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            WeChatSender.captureInstance(className, param.thisObject);
                        }
                    });
                    hooked++;
                } catch (Throwable ignored) {
                }
            }
            XposedInit.log("兜底抓实例 " + className + " 挂了 " + hooked + " 个方法");
        } catch (Throwable t) {
            XposedInit.log("兜底抓实例装不上 " + className + "：" + t);
        }
    }

    /** "Lpt1/g;" → "pt1.g" */
    private static String dotted(String descriptor) {
        String name = descriptor;
        if (name.startsWith("L") && name.endsWith(";")) name = name.substring(1, name.length() - 1);
        return name.replace('/', '.');
    }

    private static void capture(String label, Object[] args, Object self) {
        if (dumps.get() >= MAX_DUMPS) return;
        dumps.incrementAndGet();
        StringBuilder sb = new StringBuilder();
        sb.append("取证 ").append(label).append(" args=").append(args == null ? 0 : args.length);
        if (args != null) {
            for (int i = 0; i < args.length; i++) {
                Object arg = args[i];
                sb.append("\n  arg").append(i).append(": ")
                        .append(arg == null ? "null" : arg.getClass().getName());
                if (arg != null && !(arg instanceof String) && !(arg instanceof Number)) {
                    dumpFields(sb, arg);
                } else if (arg != null) {
                    sb.append(" = ").append(arg);
                }
            }
        }
        if (self != null) {
            sb.append("\n  this: ").append(self.getClass().getName());
            dumpFields(sb, self);
        }
        sb.append("\n  栈: ").append(shortStack());
        XposedInit.log(sb.toString());
    }

    private static void dumpFields(StringBuilder sb, Object obj) {
        Class<?> type = obj.getClass();
        int shown = 0;
        while (type != null && type != Object.class && shown < 40) {
            for (Field f : type.getDeclaredFields()) {
                if (f.getName().startsWith("$")) continue;
                try {
                    f.setAccessible(true);
                    Object v = f.get(obj);
                    String text = v == null ? "null" : String.valueOf(v);
                    if (text.length() > 120) text = text.substring(0, 120) + "…";
                    sb.append("\n      ").append(f.getName()).append(" (")
                            .append(f.getType().getSimpleName()).append(") = ").append(text);
                    shown++;
                } catch (Throwable ignored) {
                }
            }
            type = type.getSuperclass();
        }
    }

    /** 只取最靠上的 3 个 com.tencent 帧，用来定位调用方。 */
    private static String stackTop() {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (StackTraceElement e : stack) {
            if (!e.getClassName().startsWith("com.tencent")) continue;
            if (n > 0) sb.append(" < ");
            sb.append(e.getClassName()).append("#").append(e.getMethodName());
            if (++n >= 3) break;
        }
        return sb.toString();
    }

    private static String shortStack() {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        StringBuilder sb = new StringBuilder();
        int added = 0;
        for (StackTraceElement e : stack) {
            String c = e.getClassName();
            if (!c.startsWith("com.tencent")) continue;
            if (added++ >= 6) break;
            sb.append(c).append("#").append(e.getMethodName()).append(" < ");
        }
        return sb.toString();
    }
}
