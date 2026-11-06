package com.dsh.wechatbridge;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * 入站消息合并。
 *
 * 连发三条"在吗""在吗""人呢"，如果每条都跑一次模型、排一次队，
 * 回复会被拖到十几秒后，看着就像机器人卡住。
 * 所以同一个会话的消息先攒 1.2 秒，合成一条再上报，模型也只需要回一次。
 */
public final class InboundBuffer {

    private static final long WINDOW_MS = 1200L;
    private static final Map<String, Pending> PENDING = new ConcurrentHashMap<>();
    private static final ScheduledExecutorService TIMER = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "wxbridge-debounce");
        t.setDaemon(true);
        return t;
    });

    private static final class Pending {
        final StringBuilder text = new StringBuilder();
        WeChatMessage first;
        WeChatMessage last;
        ScheduledFuture<?> task;
        int count;
    }

    private InboundBuffer() {}

    public static void offer(final BridgeClient client, WeChatMessage msg) {
        if (msg == null) return;
        String key = msg.sessionId;
        Pending p = PENDING.computeIfAbsent(key, k -> new Pending());
        synchronized (p) {
            if (p.first == null) p.first = msg;
            p.last = msg;
            p.count++;
            if (p.text.length() > 0) p.text.append('\n');
            p.text.append(msg.content);
            if (p.task != null) p.task.cancel(false);
            p.task = TIMER.schedule(() -> flush(client, key), WINDOW_MS, TimeUnit.MILLISECONDS);
        }
    }

    private static void flush(BridgeClient client, String key) {
        Pending p = PENDING.remove(key);
        if (p == null) return;
        WeChatMessage out;
        int count;
        synchronized (p) {
            if (p.first == null) return;
            count = p.count;
            out = p.last;
            out.content = p.text.toString();
            out.msgId = p.first.msgId + "+" + count; // 合并后的去重键
            out.timestamp = p.first.timestamp;
        }
        if (count > 1) XposedInit.log("合并 " + count + " 条消息 -> " + key);
        client.submitAsync(out);
    }

    /** 微信退出/模块重载时清空，避免残留半截。 */
    public static void reset() {
        PENDING.clear();
    }
}
