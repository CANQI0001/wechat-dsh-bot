package com.dsh.wechatbridge;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * 屏蔽微信更新。
 *
 * 三处下手，任何一处生效就够：
 *  1. 更新检查方法：直接返回「已是最新」
 *  2. 更新弹窗 Activity：启动时 finish 掉
 *  3. 下载服务：不让它下
 *
 * 类名同样是版本相关的，先用宽容方式扫描：找到含 update 关键字的类再挂。
 */
public final class UpdateBlocker {

    private UpdateBlocker() {
    }

    public static void install(XC_LoadPackage.LoadPackageParam lpparam) {
        blockUpdateActivity();
        blockVersionCheck(lpparam);
    }

    /** 更新相关的 Activity / Dialog：见到就 finish / dismiss。 */
    private static void blockUpdateActivity() {
        try {
            XposedHelpers.findAndHookMethod(
                    android.app.Activity.class, "onCreate",
                    android.os.Bundle.class,
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            try {
                                Object activity = param.thisObject;
                                String name = activity.getClass().getName().toLowerCase();
                                if (name.contains("update") && !name.contains("updated")) {
                                    XposedInit.log("拦截更新页面：" + activity.getClass().getName());
                                    XposedHelpers.callMethod(activity, "finish");
                                }
                            } catch (Throwable ignored) {
                            }
                        }
                    });
        } catch (Throwable t) {
            XposedInit.log("更新页面拦截没装上：" + t);
        }
    }

    /** 版本检查：命中 update 相关方法就把结果改成「最新」。 */
    private static void blockVersionCheck(XC_LoadPackage.LoadPackageParam lpparam) {
        // TODO(dex)：微信的更新检查类名各版本不同，填在下面。
        String[] candidates = {
                // 例："com.tencent.mm.plugin.setting.ui.setting.SettingsAboutSystemUI#checkUpdate"
        };
        for (String candidate : candidates) {
            int hash = candidate.indexOf('#');
            if (hash <= 0) continue;
            String className = candidate.substring(0, hash);
            String method = candidate.substring(hash + 1);
            try {
                Class<?> clazz = XposedHelpers.findClass(className, lpparam.classLoader);
                XposedBridge.hookAllMethods(clazz, method, new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        XposedInit.log("已拦截更新检查，" + "返回未发现新版本");
                        param.setResult(null);
                    }
                });
                XposedInit.log("更新检查 Hook 已装：" + candidate);
            } catch (Throwable t) {
                XposedInit.log("更新检查候选失败：" + candidate + " -> " + t);
            }
        }
    }
}
