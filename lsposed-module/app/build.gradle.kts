plugins {
    id("com.android.application")
}

android {
    namespace = "com.dsh.wechatbridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.dsh.wechatbridge"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // 桥接服务地址：DSH 插件监听 127.0.0.1:18765
        buildConfigField("String", "BRIDGE_URL", "\"http://127.0.0.1:18765\"")
        buildConfigField("String", "BRIDGE_TOKEN", "\"\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // XposedBridge API: provided by LSPosed at runtime, compile-time only.
    compileOnly("de.robv.android.xposed:api:82")
    compileOnly("de.robv.android.xposed:api:82:sources")
}
