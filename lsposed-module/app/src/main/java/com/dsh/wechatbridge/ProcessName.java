package com.dsh.wechatbridge;

import java.io.BufferedReader;
import java.io.FileReader;

/** 取当前进程名（读 /proc/self/cmdline），日志里一眼看出主进程还是小程序子进程。 */
final class ProcessName {

    private static String cached;

    private ProcessName() {
    }

    static String current() {
        if (cached != null) return cached;
        String name = "?";
        try (BufferedReader reader = new BufferedReader(new FileReader("/proc/self/cmdline"))) {
            String line = reader.readLine();
            if (line != null) {
                int nul = line.indexOf('\0');
                name = nul >= 0 ? line.substring(0, nul) : line;
            }
        } catch (Throwable ignored) {
        }
        cached = name;
        return name;
    }
}
