package com.dsh.wechatbridge;

import android.content.Context;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * 微信收发消息的 Hook 装配。
 *
 * ⚠️ 这里的方法名/类名是「待填」状态：微信每个版本的混淆名都不一样，
 * 必须拿到目标版本的 APK 反编译后填。填之前模块不会误 Hook，只是日志里
 * 报 hook 失败，微信照常运行。
 *
 * 填的时候只需要改 {@link #RECEIVE_CANDIDATES} 和 {@link WeChatSender}，
 * 协议层和桥接层不用动。
 */
public final class Hooks {

    private Hooks() {
    }

    /**
     * 收消息 Hook 的候选点。按顺序尝试，第一个成功的生效。
     *
     * 每一项形如 "类名#方法名"，反编译后从「消息入库 / 新消息回调」附近找：
     *  - 新消息落库：MsgInfo 构造或 Storage 的 insert 系列
     *  - 通知层：NewMsgNotifier / 消息推送回调
     *
     * 建议优先找「入库前」的方法，能拿到 MsgInfo 的 content/talker/type。
     */
    static final String[] RECEIVE_CANDIDATES = {
            // TODO(dex): 例 "com.tencent.mm.storage.ar#a" 之类，需按版本填
    };

    /** 主进程里拿 Context 启动静音保活，让后台不被冻结。 */
    private static void installKeepAlive(XC_LoadPackage.LoadPackageParam lpparam) {
        if (!"com.tencent.mm".equals(lpparam.processName)) return;
        try {
            XposedHelpers.findAndHookMethod("android.app.Application", lpparam.classLoader,
                    "attach", Context.class, new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            KeepAlive.start((Context) param.args[0]);
                        }
                    });
        } catch (Throwable t) {
            XposedInit.log("保活 Hook 失败：" + t);
        }
    }

    public static void install(XC_LoadPackage.LoadPackageParam lpparam, BridgeClient client) {
        WeChatSender.bindClassLoader(lpparam.classLoader);
        client.setReplySink(new WeChatSender());
        client.healthCheckAsync();
        client.startOutboxPoller();
        // 首选：WCDB 数据库层（类名稳定，跨版本）
        new DbHook(client).install(lpparam);
        NotifyHook.install(lpparam.classLoader); // 取证：通知里到底有没有内容
        installKeepAlive(lpparam);
        // 备选：业务类 Hook（类名待填，见 RECEIVE_CANDIDATES）
        installReceive(lpparam, client);
        // 发送链路取证（8.0.76）：只在日志里输出，不改微信行为
        SendProbe.install(lpparam);
    }

    private static void installReceive(XC_LoadPackage.LoadPackageParam lpparam, BridgeClient client) {
        if (RECEIVE_CANDIDATES.length == 0) {
            XposedInit.log("业务类收消息 Hook 未配置（收消息已由 WCDB 层负责）");
            return;
        }
        ReceiveHook hook = new ReceiveHook(client);
        for (String candidate : RECEIVE_CANDIDATES) {
            int hash = candidate.indexOf('#');
            if (hash <= 0) continue;
            String className = candidate.substring(0, hash);
            String method = candidate.substring(hash + 1);
            try {
                hook.attach(lpparam.classLoader, className, method);
                XposedInit.log("收消息 Hook 已装：" + candidate);
                return;
            } catch (Throwable t) {
                XposedInit.log("收消息候选失败：" + candidate + " -> " + t);
            }
        }
        XposedInit.log("所有收消息候选都失败，检查微信版本。");
    }
}
