package com.dsh.wechatbridge;

import android.util.Log;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * 模块入口。作用域：com.tencent.mm。
 *
 * 这里只做三件事：
 *  1. 微信进程起来后建立到 DSH 桥接服务的客户端
 *  2. 装收/发消息 Hook（类名先留空，见 WeChatHooks）
 *  3. 装更新屏蔽 Hook
 */
public class XposedInit implements IXposedHookLoadPackage {

    public static final String TAG = "WeChatBridge";
    public static final String WECHAT_PKG = "com.tencent.mm";

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam lpparam) {
        if (!WECHAT_PKG.equals(lpparam.packageName)) return;

        XposedBridge.log(TAG + ": 已注入微信 " + lpparam.processName);
        if ("com.tencent.mm".equals(lpparam.processName)) {
            log("WeChatBridge " + BuildConfig.VERSION_NAME + " 启动");
        }
        BridgeClient client = new BridgeClient(BuildConfig.BRIDGE_URL, BuildConfig.BRIDGE_TOKEN);
        Hooks.install(lpparam, client);
        UpdateBlocker.install(lpparam);
    }

    /** 统一日志出口：logcat + LSPosed 日志 + 回传 DSH（data/bridge.log）。 */
    public static void log(String message) {
        String tagged = TAG + ": " + message;
        Log.i(TAG, message);
        XposedBridge.log(tagged);
        try {
            RemoteLog.push(ProcessName.current() + " | " + message);
        } catch (Throwable ignored) {
        }
    }

    /** 小工具：安全地找类/方法，找不到只记日志不抛。 */
    public static void tryHook(String className, ClassLoader loader, String method, Object... params) {
        try {
            XposedHelpers.findAndHookMethod(className, loader, method, params);
            log("hooked " + className + "#" + method);
        } catch (Throwable t) {
            log("hook 失败 " + className + "#" + method + " -> " + t);
        }
    }

    /** 供 Hook 里使用的空实现，避免每次重复写。 */
    public static abstract class SimpleHook extends XC_MethodHook {
    }
}
