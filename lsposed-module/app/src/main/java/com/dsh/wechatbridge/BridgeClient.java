package com.dsh.wechatbridge;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 到 DSH 桥接插件的 HTTP 客户端。
 *
 * 只做同步 HTTP（在后台线程调用），JSON 手写，不引第三方依赖，
 * 这样模块保持零依赖、体积小、不会被微信的类加载器影响。
 */
public final class BridgeClient {

    /** 回复落地的出口：由微信侧的实现把文本发出去。 */
    public interface ReplySink {
        /** 发一条，返回是否真的发出去了。false 会被上层重试。 */
        boolean send(String sessionId, String chatType, String text);
    }

    private final String baseUrl;
    private final String token;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ReplySink sink;

    public BridgeClient(String baseUrl, String token) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.token = token == null ? "" : token;
    }

    public void setReplySink(ReplySink sink) {
        this.sink = sink;
    }

    /** 连通性自检，微信启动时打一条日志。 */
    public void healthCheckAsync() {
        new Thread(() -> {
            try {
                JSONObject health = get("/api/health");
                XposedInit.log("桥接在线：" + health.optString("status")
                        + " 模型 " + health.optString("model"));
            } catch (Throwable t) {
                XposedInit.log("桥接不可用：" + t);
            }
        }, "wxbridge-health").start();
    }

    /**
     * 上报一条收到的微信消息，拿回分段回复并按节奏发出。
     * 整个过程在后台线程，回复经 main Handler 延迟投递。
     */
    public void submitAsync(WeChatMessage message) {
        new Thread(() -> {
            try {
                JSONObject body = message.toJson();
                JSONObject response = post("/api/message", body);
                String status = response.optString("status");
                if (!"accepted".equals(status)) {
                    XposedInit.log("未回复：" + status + " " + response.optString("code")
                            + " " + response.optString("message"));
                    return;
                }
                JSONObject reply = response.optJSONObject("reply");
                if (reply == null) return;
                JSONArray segments = reply.optJSONArray("segments");
                if (segments == null || segments.length() == 0) return;
                long delay = reply.optLong("delayMs", 3000L);
                long gap = reply.optLong("segmentDelayMs", 1200L);
                String sessionId = reply.optString("sessionId", message.sessionId);
                String chatType = message.chatType;
                List<String> texts = new ArrayList<>();
                for (int i = 0; i < segments.length(); i++) {
                    String text = segments.optString(i, "");
                    if (!text.isEmpty()) texts.add(text);
                }
                schedule(texts, delay, gap, sessionId, chatType);
            } catch (Throwable t) {
                XposedInit.log("上报失败：" + t);
            }
        }, "wxbridge-send").start();
    }

    /**
     * 全局单线程发送队列。
     *
     * 微信对同一会话的连发很敏感：并发或间隔太短，后一条会返回 false，
     * 所以这里把所有回复排成一个队，一次只发一条，段间至少 400ms，
     * 失败退避重试。多条回复同时到达也不会互相踩。
     */
    private static final java.util.concurrent.BlockingQueue<SendJob> QUEUE =
            new java.util.concurrent.LinkedBlockingQueue<>();
    private static volatile Thread workerThread;

    private static final class SendJob {
        final List<String> texts;
        final long firstDelay;
        final long gap;
        final String sessionId;
        final String chatType;
        final ReplySink sink;

        SendJob(List<String> texts, long firstDelay, long gap, String sessionId, String chatType, ReplySink sink) {
            this.texts = texts;
            this.firstDelay = firstDelay;
            this.gap = gap;
            this.sessionId = sessionId;
            this.chatType = chatType;
            this.sink = sink;
        }
    }

    private void schedule(List<String> texts, long firstDelay, long gap, String sessionId, String chatType) {
        XposedInit.log("安排发送 " + texts.size() + " 段，首延迟 " + firstDelay + "ms，段间隔 " + gap + "ms");
        ReplySink current = sink;
        if (current == null) {
            XposedInit.log("没有发送出口，丢弃回复");
            return;
        }
        if (QUEUE.size() > 8) {
            XposedInit.log("发送队列积压，丢弃这次回复");
            return;
        }
        QUEUE.offer(new SendJob(texts, firstDelay, gap, sessionId, chatType, current));
        startWorker();
    }

    private static synchronized void startWorker() {
        if (workerThread != null && workerThread.isAlive()) return;
        workerThread = new Thread(() -> {
            while (true) {
                SendJob job;
                try {
                    job = QUEUE.poll(1, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    return;
                }
                if (job == null) continue;
                runJob(job);
            }
        }, "wxbridge-sender");
        workerThread.setDaemon(true);
        workerThread.start();
    }

    private static void runJob(SendJob job) {
        try {
            Thread.sleep(Math.max(0, job.firstDelay));
        } catch (InterruptedException ignored) {
            return;
        }
        for (int i = 0; i < job.texts.size(); i++) {
            String text = job.texts.get(i);
            boolean sent = false;
            for (int attempt = 1; attempt <= 3 && !sent; attempt++) {
                try {
                    sent = job.sink.send(job.sessionId, job.chatType, text);
                } catch (Throwable t) {
                    XposedInit.log("发送失败：" + t);
                }
                if (!sent) {
                    XposedInit.log("第 " + attempt + " 次发送未成功，稍后重试");
                    try {
                        Thread.sleep(400L * attempt);
                    } catch (InterruptedException ignored) {
                        return;
                    }
                }
            }
            if (!sent) XposedInit.log("放弃这一段：" + text);
            if (i < job.texts.size() - 1) {
                try {
                    Thread.sleep(Math.max(400L, job.gap));
                } catch (InterruptedException ignored) {
                    return;
                }
            }
        }
    }

    private JSONObject get(String path) throws Exception {
        HttpURLConnection conn = open(path, "GET");
        try (InputStream in = conn.getInputStream()) {
            return new JSONObject(readAll(in));
        } finally {
            conn.disconnect();
        }
    }

    private JSONObject post(String path, JSONObject body) throws Exception {
        HttpURLConnection conn = open(path, "POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        int code = conn.getResponseCode();
        InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String text = stream == null ? "" : readAll(stream);
        try {
            return new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    private HttpURLConnection open(String path, String method) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(120_000); // 模型思考可能久一点
        if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
        return conn;
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }
}
