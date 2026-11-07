package com.dsh.wechatbridge;

import android.graphics.BitmapFactory;

import java.io.File;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;

/**
 * 微信自己解码图片时，会拿真实路径调 BitmapFactory.decodeFile。
 * 我们不去猜缓存目录，直接记下它解过哪张图 —— 这是最可靠的路径来源。
 */
public final class ImagePathHook {

    private static volatile String lastPath;
    private static volatile long lastAt;
    private static int logged = 0;

    private ImagePathHook() {}

    public static void install(ClassLoader loader) {
        try {
            Class<?> factory = XposedHelpers.findClass("android.graphics.BitmapFactory", loader);
            XC_MethodHook hook = new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    try {
                        if (param.args.length < 1 || !(param.args[0] instanceof String)) return;
                        String path = (String) param.args[0];
                        if (path.isEmpty()) return;
                        File f = new File(path);
                        if (!f.isFile() || f.length() < 4096) return;
                        lastPath = path;
                        lastAt = System.currentTimeMillis();
                        if (logged < 5) {
                            logged++;
                            XposedInit.log("微信解码图片：" + path);
                        }
                    } catch (Throwable ignored) {
                    }
                }
            };
            XposedBridge.hookAllMethods(factory, "decodeFile", hook);
            XposedInit.log("图片解码 Hook 已挂");
        } catch (Throwable t) {
            XposedInit.log("图片解码 Hook 失败：" + t);
        }
    }

    /** 最近 N 毫秒内微信解码过的图；没有就返回 null。 */
    public static String recent(long withinMs) {
        String path = lastPath;
        if (path == null) return null;
        if (System.currentTimeMillis() - lastAt > withinMs) return null;
        return new File(path).isFile() ? path : null;
    }
}
