package com.dsh.wechatbridge;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;

/**
 * 让微信主进程别被系统「缓存应用冻结」。
 *
 * 微信在后台被冻结时，消息能弹通知，但消息表要等到主进程解冻才写，
 * 收消息 Hook 就会晚一两分钟。播放静音音频的进程属于「可感知」进程，
 * 不会被放进缓存冷宫，消息能及时入库。
 *
 * 代价：一条音量为 0 的音频流，耗电可以忽略。
 */
public final class KeepAlive {

    private static volatile boolean running = false;
    private static AudioTrack track;

    private KeepAlive() {}

    public static void start(Context context) {
        if (running || context == null) return;
        running = true;
        Thread t = new Thread(() -> {
            try {
                int minBuf = AudioTrack.getMinBufferSize(8000,
                        AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                int bufSize = Math.max(minBuf, 8000);
                track = new AudioTrack.Builder()
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .build())
                        .setAudioFormat(new AudioFormat.Builder()
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setSampleRate(8000)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .build())
                        .setBufferSizeInBytes(bufSize)
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build();
                track.setVolume(0f);
                track.play();
                short[] silence = new short[bufSize / 2];
                while (running) {
                    track.write(silence, 0, silence.length);
                    Thread.sleep(200);
                }
            } catch (Throwable t2) {
                XposedInit.log("保活音频没起来：" + t2);
            } finally {
                try {
                    if (track != null) {
                        track.stop();
                        track.release();
                    }
                } catch (Throwable ignored) {
                }
            }
        }, "wxbridge-keepalive");
        t.setDaemon(true);
        t.start();
        XposedInit.log("静音保活已启动（防止后台冻结）");
    }

    public static void stop() {
        running = false;
    }
}
