package com.dsh.wechatbridge;

import java.lang.reflect.Method;

/**
 * 只读查询帮手：拿 WCDB 的 SQLiteDatabase 句柄按 msgId 取某个字段。
 *
 * 图片消息的问题：insert 那一行里根本没有 imgPath（微信后补），
 * 所以监听 update，再用这里把 imgPath 查出来。
 */
public final class DbQuery {

    private DbQuery() {}

    /** 查一行里某列的值；查不到返回 null。 */
    public static String column(Object database, String sql, String arg, String column) {
        if (database == null) return null;
        Object cursor = null;
        try {
            cursor = rawQuery(database, sql, new String[] { arg });
            if (cursor == null) return null;
            Object moved = call(cursor, "moveToFirst");
            if (!(moved instanceof Boolean) || !((Boolean) moved)) return null;
            int idx = indexOf(cursor, column);
            if (idx < 0) return null;
            Object value = call(cursor, "getString", idx);
            return value instanceof String ? (String) value : null;
        } catch (Throwable t) {
            return null;
        } finally {
            closeQuietly(cursor);
        }
    }

    /** 查一行，返回「列名 -> 值」（只保留非空）；查不到返回 null。 */
    public static java.util.Map<String, String> row(Object database, String sql, String arg) {
        if (database == null) return null;
        Object cursor = null;
        try {
            cursor = rawQuery(database, sql, new String[] { arg });
            if (cursor == null) return null;
            Object moved = call(cursor, "moveToFirst");
            if (!(moved instanceof Boolean) || !((Boolean) moved)) return null;
            Object countObj = call(cursor, "getColumnCount");
            Object namesObj = call(cursor, "getColumnNames");
            int count = countObj instanceof Integer ? (Integer) countObj : 0;
            String[] names = namesObj instanceof String[] ? (String[]) namesObj : new String[0];
            java.util.Map<String, String> row = new java.util.LinkedHashMap<>();
            for (int i = 0; i < count && i < names.length; i++) {
                Object v = call(cursor, "getString", i);
                if (v instanceof String && !((String) v).isEmpty()) row.put(names[i], (String) v);
            }
            return row;
        } catch (Throwable t) {
            return null;
        } finally {
            closeQuietly(cursor);
        }
    }

    private static Object rawQuery(Object database, String sql, String[] args) {
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

    private static void closeQuietly(Object cursor) {
        if (cursor == null) return;
        try {
            call(cursor, "close");
        } catch (Throwable ignored) {
        }
    }
}
