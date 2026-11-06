package com.dsh.wechatbridge;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * 把模块日志回传到 DSH 桥接插件（/api/log）。
 *
 * 目的：手机上的 logcat / LSPosed 日志不方便来回贴，回传之后日志落在
 * DSH 侧的 data/bridge.log，一次就能看全（包括哪个进程 hook 上了）。
 *
 * 网络在后台线程，失败静默丢弃，绝不影响微信。
 */
public final class RemoteLog {

    private static final LinkedBlockingQueue<String> QUEUE = new LinkedBlockingQueue<>(500);
    private static volatile boolean started = false;

    private RemoteLog() {
    }

    public static void push(String line) {
        if (line == null || line.isEmpty()) return;
        QUEUE.offer(line.length() > 700 ? line.substring(0, 700) + "…" : line);
        ensureWorker();
    }

    private static void ensureWorker() {
        if (started) return;
        synchronized (RemoteLog.class) {
            if (started) return;
            started = true;
            Thread worker = new Thread(RemoteLog::loop, "wxbridge-log");
            worker.setDaemon(true);
            worker.start();
        }
    }

    private static void loop() {
        while (true) {
            try {
                Thread.sleep(2000);
                List<String> batch = new ArrayList<>();
                QUEUE.drainTo(batch, 40);
                if (batch.isEmpty()) continue;
                post(batch);
            } catch (Throwable ignored) {
                // 日志线程不能把微信搞挂
            }
        }
    }

    private static void post(List<String> lines) {
        HttpURLConnection conn = null;
        try {
            String base = BuildConfig.BRIDGE_URL;
            if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
            conn = (HttpURLConnection) new URL(base + "/api/log").openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            if (!BuildConfig.BRIDGE_TOKEN.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + BuildConfig.BRIDGE_TOKEN);
            }
            JSONArray array = new JSONArray();
            for (String line : lines) array.put(line);
            JSONObject body = new JSONObject();
            body.put("lines", array);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            conn.getResponseCode();
        } catch (Throwable ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
