package com.dsh.wechatbridge;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;

/**
 * 把微信缓存的图片缩成能塞进协议的尺寸。
 *
 * 原图动辄两三兆，base64 之后更大；模型看 512px 足够认东西，
 * 所以这里等比缩到长边 640，JPEG 质量 70，通常 30–80KB。
 */
public final class ImageUtil {

    private static final int MAX_EDGE = 640;
    private static final int QUALITY = 70;
    private static final long MAX_FILE = 12L * 1024 * 1024;
    private static final java.util.concurrent.atomic.AtomicBoolean SCAN_LOGGED =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    private ImageUtil() {}

    /** 读图 -> 缩图 -> base64；失败返回 null。 */
    /**
     * 缩略图旁边往往还躺着同一条消息的清晰版（文件名共享同一个 md5）。
     * 有就换成体积最大的那个。
     */
    public static String bestVariant(String path) {
        if (path == null) return null;
        File file = new File(path);
        String name = file.getName();
        int us = name.indexOf('_');
        String key = us >= 0 ? name.substring(us + 1) : name;
        if (key.length() < 16) return path;
        File dir = file.getParentFile();
        if (dir == null) return path;
        File best = file;
        for (File f : listOrEmpty(dir)) {
            if (f.isFile() && f.getName().contains(key) && f.length() > best.length()) best = f;
        }
        // 再看一层上级目录（image2/<xx>/<yy>/ 这种结构）
        File parent = dir.getParentFile();
        if (parent != null) {
            for (File sub : listOrEmpty(parent)) {
                if (!sub.isDirectory()) continue;
                for (File f : listOrEmpty(sub)) {
                    if (f.isFile() && f.getName().contains(key) && f.length() > best.length()) best = f;
                }
            }
        }
        return best.getAbsolutePath();
    }

    private static File[] listOrEmpty(File dir) {
        File[] list = dir.listFiles();
        return list == null ? new File[0] : list;
    }

    public static String encodeSmall(String path) {
        path = bestVariant(path);
        if (path == null || path.isEmpty()) return null;
        try {
            File file = new File(path);
            if (!file.isFile() || file.length() <= 0 || file.length() > MAX_FILE) return null;
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, probe);
            if (probe.outWidth <= 0 || probe.outHeight <= 0) return null;

            int sample = 1;
            while (Math.max(probe.outWidth, probe.outHeight) / (sample * 2) >= MAX_EDGE) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bitmap = BitmapFactory.decodeFile(path, opts);
            if (bitmap == null) return null;

            int longEdge = Math.max(bitmap.getWidth(), bitmap.getHeight());
            if (longEdge > MAX_EDGE) {
                float scale = MAX_EDGE / (float) longEdge;
                Bitmap scaled = Bitmap.createScaledBitmap(bitmap,
                        Math.max(1, Math.round(bitmap.getWidth() * scale)),
                        Math.max(1, Math.round(bitmap.getHeight() * scale)), true);
                if (scaled != bitmap) bitmap.recycle();
                bitmap = scaled;
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, QUALITY, out);
            bitmap.recycle();
            byte[] bytes = out.toByteArray();
            if (bytes.length == 0) return null;
            return Base64.encodeToString(bytes, Base64.NO_WRAP);
        } catch (Throwable t) {
            XposedInit.log("缩图失败：" + t);
            return null;
        }
    }

    /**
     * 微信可能跑在分身 / 多用户空间（uid 99910339 = 用户 999 + 应用 10339），
     * 数据目录就不是 /data/user/0。先按自己的 uid 推用户号，再补 0 号和常见位置。
     */
    private static String[] buildRoots() {
        String pkg = "com.tencent.mm";
        java.util.LinkedHashSet<String> roots = new java.util.LinkedHashSet<>();
        int uid;
        try {
            uid = android.os.Process.myUid();
        } catch (Throwable t) {
            uid = 0;
        }
        int user = uid / 100000;
        for (int u : new int[] { user, 0 }) {
            roots.add("/data/user/" + u + "/" + pkg + "/MicroMsg");
            roots.add("/data/user/" + u + "/" + pkg);
            roots.add("/data/user_de/" + u + "/" + pkg + "/MicroMsg");
            roots.add("/storage/emulated/" + u + "/Android/data/" + pkg + "/MicroMsg");
            roots.add("/storage/emulated/" + u + "/tencent/MicroMsg");
        }
        roots.add("/data/data/" + pkg);
        roots.add("/sdcard/Android/data/" + pkg + "/MicroMsg");
        roots.add("/sdcard/tencent/MicroMsg");
        return roots.toArray(new String[0]);
    }

    private static final String[] ROOTS = buildRoots();

    /**
     * 微信 imgPath 有三种形态：
     *   1) 真实文件路径
     *   2) THUMBNAIL_DIRPATH://th_xxx   —— 缩略图在缓存里的记号，不是路径
     *   3) IMG_PATH://xxx
     * 对 2/3 就去 MicroMsg/<账号>/image2 下按文件名找。
     */
    public static String resolvePath(String raw) {
        if (raw == null) return null;
        String p = raw.trim();
        String name = null;
        if (p.startsWith("THUMBNAIL_DIRPATH://")) {
            name = p.substring("THUMBNAIL_DIRPATH://".length());
        } else if (p.startsWith("IMG_PATH://")) {
            name = p.substring("IMG_PATH://".length());
        } else if (p.startsWith("file://")) {
            p = p.substring(7);
        }
        if (name == null) {
            File f = new File(p);
            return f.isFile() ? p : null;
        }
        for (String root : ROOTS) {
            File found = findByName(new File(root), name, 0);
            if (found != null) return found.getAbsolutePath();
        }
        return null;
    }

    private static File findByName(File dir, String name, int depth) {
        if (dir == null || depth > 4) return null;
        File[] list = dir.listFiles();
        if (list == null) return null;
        // 先看直接子目录，命中率最高
        for (File f : list) {
            if (f.isFile()) {
                String fn = f.getName();
                if (fn.equals(name) || fn.startsWith(name) || fn.startsWith(name + ".")) return f;
            }
        }
        for (File f : list) {
            if (f.isDirectory()) {
                File hit = findByName(f, name, depth + 1);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    /** 按 md5/hash 找缓存文件（图片 XML 里 cdnthumbmd5 / md5 就是它）。 */
    public static String findByHash(String hash) {
        if (hash == null || hash.length() < 8) return null;
        File best = null;
        for (String root : ROOTS) {
            File hit = findByHashIn(new File(root), hash, 0, best);
            if (hit != null && (best == null || hit.length() > best.length())) best = hit;
        }
        return best == null ? null : best.getAbsolutePath();
    }

    /** 同一个 md5 可能既有缩略图也有原图，挑最大的那个（更清楚）。 */
    private static File findByHashIn(File dir, String hash, int depth, File current) {
        if (dir == null || depth > 4) return current;
        File[] list = dir.listFiles();
        if (list == null) return current;
        File best = current;
        for (File f : list) {
            if (f.isFile()) {
                String fn = f.getName();
                if ((fn.startsWith(hash) || fn.contains(hash)) && f.length() > 2048) {
                    if (best == null || f.length() > best.length()) best = f;
                }
            }
        }
        for (File f : list) {
            if (f.isDirectory()) best = findByHashIn(f, hash, depth + 1, best);
        }
        return best;
    }

    /**
     * 兜底：找 image2 里最近写进来的图。
     *
     * 微信 8.0.76 的图片消息 XML 里没有 md5（只有 aeskey 和 cdnthumburl），
     * 但缩略图下载后一定落在 image2 目录里，且 mtime 就是刚才。
     */
    /**
     * 找最近的图并直接编码：候选按 mtime 从新到旧，逐个试着解码，
     * 第一个解得开的就用。这样不依赖文件名后缀（微信的缓存命名各版本不同）。
     */
    public static String findRecentDecodable(long sinceMs) {
        // 微信刚解码过的图最靠谱，先试它
        String decoded = ImagePathHook.recent(3 * 60_000L);
        if (decoded != null) {
            String b64 = encodeSmall(decoded);
            if (b64 != null) {
                XposedInit.log("图片来自解码记录：" + decoded);
                return b64;
            }
        }

        java.util.List<File> candidates = new java.util.ArrayList<>();
        int readable = 0;
        StringBuilder report = new StringBuilder();
        for (String root : ROOTS) {
            File dir = new File(root);
            int before = candidates.size();
            boolean ok = dir.isDirectory() && dir.canRead();
            if (ok) readable++;
            else {
                report.append(root).append("=不可读 ");
                continue;
            }
            collectRecent(dir, sinceMs, 0, candidates);
            report.append(root).append("=").append(String.valueOf(candidates.size() - before)).append(' ');
        }
        candidates.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        if (SCAN_LOGGED.compareAndSet(false, true)) {
            XposedInit.log("图片扫描身份 uid=" + android.os.Process.myUid()
                    + "，用户号=" + (android.os.Process.myUid() / 100000));
            StringBuilder names = new StringBuilder();
            for (int i = 0; i < Math.min(3, candidates.size()); i++) {
                names.append(candidates.get(i).getName()).append(' ');
            }
            XposedInit.log("图片缓存：可读目录 " + readable + "/" + ROOTS.length
                    + "，近期文件 " + candidates.size() + " 个"
                    + (names.length() > 0 ? "（最新：" + names.toString().trim() + "）" : "")
                    + " 明细：" + report.toString().trim());
            StringBuilder sample = new StringBuilder();
            for (int i = 0; i < Math.min(3, candidates.size()); i++) {
                File f = candidates.get(i);
                sample.append(f.getName()).append('(').append(f.length() / 1024).append("KB,")
                        .append((System.currentTimeMillis() - f.lastModified()) / 1000).append("s前) ");
            }
            XposedInit.log("图片缓存候选：" + sample.toString().trim());
        }
        int tried = 0;
        for (File f : candidates) {
            if (tried++ > 20) break;
            String b64 = encodeSmall(f.getAbsolutePath());
            if (b64 != null) {
                XposedInit.log("图片缓存命中：" + f.getAbsolutePath());
                return b64;
            }
        }
        return null;
    }

    private static void collectRecent(File dir, long sinceMs, int depth, java.util.List<File> out) {
        if (dir == null || depth > 4) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            if (f.isFile()) {
                if (f.length() > 2048 && f.lastModified() >= sinceMs) out.add(f);
            } else if (f.isDirectory()) {
                collectRecent(f, sinceMs, depth + 1, out);
            }
        }
    }

    public static String findRecent(long sinceMs, int maxDepth) {
        File best = null;
        int readable = 0;
        for (String root : ROOTS) {
            File dir = new File(root);
            if (dir.isDirectory() && dir.canRead()) readable++;
        }
        if (readable > 0 && SCAN_LOGGED.compareAndSet(false, true)) {
            XposedInit.log("图片目录可读 " + readable + " 个（共 " + ROOTS.length + " 个候选）");
        } else if (readable == 0 && SCAN_LOGGED.compareAndSet(false, true)) {
            XposedInit.log("图片目录一个都读不了，微信可能把文件放在别处");
        }
        for (String root : ROOTS) {
            File hit = findRecentIn(new File(root), sinceMs, 0, maxDepth, best);
            if (hit != null && (best == null || hit.lastModified() > best.lastModified())) best = hit;
        }
        return best == null ? null : best.getAbsolutePath();
    }

    private static File findRecentIn(File dir, long sinceMs, int depth, int maxDepth, File current) {
        if (dir == null || depth > maxDepth) return current;
        File[] list = dir.listFiles();
        if (list == null) return current;
        File best = current;
        for (File f : list) {
            if (f.isFile()) {
                if (f.length() > 2048 && f.lastModified() >= sinceMs) {
                    String n = f.getName().toLowerCase();
                    if (n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png")
                            || n.startsWith("th_") || n.contains("img")) {
                        if (best == null || f.lastModified() > best.lastModified()) best = f;
                    }
                }
            }
        }
        for (File f : list) {
            if (f.isDirectory()) best = findRecentIn(f, sinceMs, depth + 1, maxDepth, best);
        }
        return best;
    }

    /** 微信消息里 imgPath 可能带前缀，去掉 file:// 之类。 */
    public static String cleanPath(String raw) {
        if (raw == null) return null;
        String p = raw.trim();
        if (p.startsWith("file://")) p = p.substring(7);
        return p.isEmpty() ? null : p;
    }
}
