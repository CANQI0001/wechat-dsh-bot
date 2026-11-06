#!/bin/bash
# 在没有 Android Studio 的机器上直接出 APK：javac → d8 → aapt → zipalign → apksigner
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULE="$ROOT/app/src/main"
OUT="$ROOT/build/manual"
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-arm64}"
export PATH="$JAVA_HOME/bin:$PATH"
JAVAC="$JAVA_HOME/bin/javac"
KEYTOOL="$JAVA_HOME/bin/keytool"
JAVA="$JAVA_HOME/bin/java"

ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
XPOSED_JAR="${XPOSED_JAR:-/tmp/xposed-api.jar}"
R8_JAR="${R8_JAR:-/tmp/r8.jar}"

VER="$(cat "$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
VERCODE="$(cat "$ROOT/VERSION_CODE" 2>/dev/null || echo 1)"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

echo "== 1/5 javac =="
find "$MODULE/java" -name "*.java" > "$OUT/sources.txt"
if [ ! -f "$MODULE/java/com/dsh/wechatbridge/BuildConfig.java" ]; then
  cat > "$OUT/BuildConfig.java" <<'EOF'
package com.dsh.wechatbridge;
public final class BuildConfig {
    public static final String VERSION_NAME = "dev";
    public static final String BRIDGE_URL = "http://127.0.0.1:18765";
    public static final String BRIDGE_TOKEN = "";
}
EOF
  sed -i "s/VERSION_NAME = \"dev\"/VERSION_NAME = \"$VER\"/" "$OUT/BuildConfig.java"
  echo "$OUT/BuildConfig.java" >> "$OUT/sources.txt"
fi
"$JAVAC" -nowarn -encoding UTF-8 --release 11 \
  -cp "$ANDROID_JAR:$XPOSED_JAR" \
  -d "$OUT/classes" @"$OUT/sources.txt"

echo "== 2/5 d8 =="
CLASSES=$(find "$OUT/classes" -name "*.class")
"$JAVA" -cp "$R8_JAR" com.android.tools.r8.D8 \
  --min-api 26 --lib "$ANDROID_JAR" --output "$OUT/dex" $CLASSES

echo "== 3/5 aapt =="
aapt package -f \
  --version-code "$VERCODE" \
  --version-name "$VER" \
  -M "$MODULE/AndroidManifest.xml" \
  -A "$MODULE/assets" \
  -I "$ANDROID_JAR" \
  -F "$OUT/unsigned.apk"

(cd "$OUT/dex" && aapt add "$OUT/unsigned.apk" classes.dex >/dev/null)

echo "== 4/5 zipalign =="
zipalign -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== 5/5 sign =="
KS="$ROOT/build/debug.keystore"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -v -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --min-sdk-version 26 --out "$OUT/wechat-bridge-$VER.apk" "$OUT/aligned.apk"

echo
echo "APK: $OUT/wechat-bridge-$VER.apk"
ls -la "$OUT/wechat-bridge-$VER.apk"
