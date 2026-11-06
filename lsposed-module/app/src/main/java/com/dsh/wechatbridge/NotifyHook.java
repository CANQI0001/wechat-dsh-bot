package com.dsh.wechatbridge;

import android.app.Notification;
import android.os.Bundle;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;

/**
 * 取证用：看微信在哪个进程、什么时刻弹通知，通知里带了什么内容。
 *
 * 背景：后台被系统冻结时，微信能弹带内容通知，但消息表要等主进程解冻才写，
 * 所以收消息 Hook 会晚一两分钟。先确认通知里的内容够不够用来回话。
 */
public final class NotifyHook {

    private static int logged = 0;

    private NotifyHook() {}

    public static void install(ClassLoader loader) {
        try {
            Class<?> nm = XposedHelpers.findClass("android.app.NotificationManager", loader);
            XposedBridge.hookAllMethods(nm, "notify", new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    try {
                        if (logged > 20) return;
                        Notification n = null;
                        for (Object arg : param.args) {
                            if (arg instanceof Notification) {
                                n = (Notification) arg;
                                break;
                            }
                        }
                        if (n == null || n.extras == null) return;
                        Bundle b = n.extras;
                        logged++;
                        XposedInit.log("通知[" + ProcessName.current() + "] tag=" + param.args[0]
                                + " title=" + trim(b.getCharSequence(Notification.EXTRA_TITLE))
                                + " text=" + trim(b.getCharSequence(Notification.EXTRA_TEXT))
                                + " big=" + trim(b.getCharSequence(Notification.EXTRA_BIG_TEXT))
                                + " keys=" + b.keySet());
                    } catch (Throwable ignored) {
                    }
                }
            });
            XposedInit.log("通知取证 Hook 已挂");
        } catch (Throwable t) {
            XposedInit.log("通知 Hook 失败：" + t);
        }
    }

    private static String trim(CharSequence cs) {
        if (cs == null) return "null";
        String s = cs.toString().replace('\n', ' ');
        return s.length() > 60 ? s.substring(0, 60) + "…" : s;
    }
}
