plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/*
 * release 签名（仅本地内测）：
 * - keystore 在 android/keystore/prism-router.jks，由 keytool 自签名生成；
 * - 口令只放在 android/gradle.properties（PRISM_STORE_PASSWORD / PRISM_KEY_PASSWORD），
 *   源码里不出现明文口令；别名默认 prism-router。
 * - keystore 缺失时（干净 clone / CI）release 自动退回未签名产物，debug 构建不受影响。
 */
val prismKeystore = rootProject.file("keystore/prism-router.jks")

android {
    namespace = "io.prism.router"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.prism.router"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            storeFile = prismKeystore
            storePassword = (project.findProperty("PRISM_STORE_PASSWORD") as String?) ?: ""
            keyAlias = (project.findProperty("PRISM_KEY_ALIAS") as String?) ?: "prism-router"
            keyPassword = (project.findProperty("PRISM_KEY_PASSWORD") as String?) ?: ""
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (prismKeystore.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    debugImplementation("androidx.compose.ui:ui-tooling")

    /* 单元测试：JVM 里跑纯逻辑；org.json 在 JVM 下由真实实现提供（android.jar 里只是桩）。 */
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
