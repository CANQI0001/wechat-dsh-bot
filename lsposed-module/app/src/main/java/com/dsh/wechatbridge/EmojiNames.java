package com.dsh.wechatbridge;

import java.lang.reflect.Method;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 表情包「外显名字」查询。
 *
 * 微信 8.0.76 的消息表里，表情消息（type=47）只有 md5，没有名字；
 * 名字存在 EmojiInfo 表（该表不在 storage 混淆范围内，表名稳定）。
 *
 * 做法：从 WCDB 的 insert hook 里抓到 SQLiteDatabase 句柄，
 * 拿 md5 去 `SELECT * FROM EmojiInfo WHERE md5=?`，按列名读 name。
 * 不依赖任何混淆过的字段名 —— 只依赖表名和列名（schema）。
 */
public final class EmojiNames {

    private static final Map<String, String> CACHE = new ConcurrentHashMap<>();
    private static volatile Object db;
    private static ExecutorService worker;
    private static final Map<String, String> KNOWN_TABLES = new ConcurrentHashMap<>();

    static {
        KNOWN_TABLES.put("name", "name");
    }

    private EmojiNames() {}

    /** 由 DbHook 调用：记住一个可用的数据库句柄。 */
    public static void bind(Object database) {
        if (database == null) return;
        db = database;
    }

    /**
     * 查表情名字。命中缓存直接返回；否则最多等 600ms。
     * 查不到返回 null（调用方退回纯 [表情]）。
     */
    public static String lookup(String md5) {
        if (md5 == null || md5.isEmpty()) return null;
        String hit = CACHE.get(md5);
        if (hit != null) return hit;
        Object handle = db;
        if (handle == null) return null;

        ExecutorService pool = pool();
        CountDownLatch done = new CountDownLatch(1);
        String[] holder = new String[1];
        try {
            pool.execute(() -> {
                try {
                    holder[0] = query(handle, md5);
                    if (holder[0] != null) CACHE.put(md5, holder[0]);
                } catch (Throwable t) {
                    XposedInit.log("表情名字查询失败：" + t);
                } finally {
                    done.countDown();
                }
            });
            done.await(600, TimeUnit.MILLISECONDS);
        } catch (Throwable t) {
            return null;
        }
        return holder[0];
    }

    private static ExecutorService pool() {
        if (worker == null) {
            synchronized (EmojiNames.class) {
                if (worker == null) {
                    worker = Executors.newSingleThreadExecutor(r -> {
                        Thread t = new Thread(r, "dsh-emoji-name");
                        t.setDaemon(true);
                        return t;
                    });
                }
            }
        }
        return worker;
    }

    private static String query(Object database, String md5) throws Exception {
        String sql = "SELECT * FROM EmojiInfo WHERE md5 = ?";
        Object cursor = callQuery(database, sql, new String[] { md5 });
        if (cursor == null) return null;
        try {
            Object moved = call(cursor, "moveToFirst");
            if (!(moved instanceof Boolean) || !((Boolean) moved)) return null;
            for (String column : new String[] { "name", "desc", "nickname" }) {
                int idx = indexOf(cursor, column);
                if (idx < 0) continue;
                Object value = call(cursor, "getString", idx);
                if (value instanceof String && !((String) value).trim().isEmpty()) {
                    return ((String) value).trim();
                }
            }
            return null;
        } finally {
            try {
                call(cursor, "close");
            } catch (Throwable ignored) {
            }
        }
    }

    /** rawQuery 的签名在各版本略有差异，挨个试。 */
    private static Object callQuery(Object database, String sql, String[] args) {
        try {
            Method m = database.getClass().getMethod("rawQuery", String.class, String[].class);
            return m.invoke(database, sql, args);
        } catch (Throwable ignored) {
        }
        try {
            Method m = database.getClass().getMethod("rawQuery", String.class, Object[].class);
            return m.invoke(database, sql, (Object) args);
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static Object call(Object target, String name, Object... args) throws Exception {
        for (Method m : target.getClass().getMethods()) {
            if (!m.getName().equals(name)) continue;
            if (m.getParameterCount() != args.length) continue;
            return m.invoke(target, args);
        }
        return null;
    }

    private static int indexOf(Object cursor, String column) {
        try {
            Object value = call(cursor, "getColumnIndex", column);
            return value instanceof Integer ? (Integer) value : -1;
        } catch (Throwable t) {
            return -1;
        }
    }
}
