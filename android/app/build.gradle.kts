import org.gradle.api.GradleException
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/*
 * 版本单一来源：`android/version.properties`。
 *
 * 规则（构建期强校验，违反直接失败，不再静默回退到写死的 1.0.9 / 9）：
 * - versionName 必须是 major.minor.patch（允许前缀 v，构建时去掉）；
 * - versionCode == major*10000 + minor*100 + patch；
 * - minor / patch 必须 < 100（否则位段串位，版本号无法单调）；
 * - CI 仍可用 -PPRISM_VERSION_NAME / -PPRISM_VERSION_CODE 覆盖，但两者必须自洽，
 *   且与 App tag（app-v<versionName>）一致由 release.yml 再校验一次。
 */
val appVersionFile = rootProject.file("version.properties")
if (!appVersionFile.isFile) {
    throw GradleException(
        "缺少 ${appVersionFile.path}：App 版本必须来自 android/version.properties，" +
            "不能在 build.gradle.kts 里写死。"
    )
}
val appVersionProps = Properties().apply {
    appVersionFile.inputStream().use { load(it) }
}

/** 解析并校验 versionName；返回去掉 v 前缀的 plain 版本号。 */
fun normalizeVersionName(raw: String, source: String): String {
    var text = raw.trim()
    if (text.isEmpty()) throw GradleException("$source 的 versionName 为空")
    text = text.removePrefix("v").removePrefix("V")
    val parts = text.split('.')
    if (parts.size != 3) {
        throw GradleException("$source 的 versionName 必须为 major.minor.patch：[$raw]")
    }
    val numbers = parts.map { part ->
        part.toIntOrNull()
            ?: throw GradleException("$source 的 versionName 含非数字段：[$raw]")
    }
    if (numbers[1] !in 0..99 || numbers[2] !in 0..99) {
        throw GradleException(
            "$source 的 versionName [$raw] 的 minor / patch 必须 < 100，" +
                "否则 versionCode 位段会串位。"
        )
    }
    return text
}

/** versionCode 规则：major*10000 + minor*100 + patch，并做 Int 上界检查。 */
fun versionCodeFor(name: String, source: String): Int {
    val parts = name.split('.').map { it.toInt() }
    val code = parts[0].toLong() * 10_000L + parts[1] * 100L + parts[2]
    if (code < 1L || code > Int.MAX_VALUE.toLong()) {
        throw GradleException("$source 的 versionCode 超出 Int 范围：$code")
    }
    return code.toInt()
}

val propVersionName = normalizeVersionName(
    appVersionProps.getProperty("versionName") ?: "",
    "android/version.properties"
)
val propVersionCodeText = (appVersionProps.getProperty("versionCode") ?: "").trim()
val propVersionCode = propVersionCodeText.toIntOrNull()
    ?: throw GradleException(
        "android/version.properties 的 versionCode 缺失或不是整数：[$propVersionCodeText]"
    )
val propExpectedCode = versionCodeFor(propVersionName, "android/version.properties")
if (propVersionCode != propExpectedCode) {
    throw GradleException(
        "android/version.properties 版本不自洽：versionName=$propVersionName 应对应 " +
            "versionCode=$propExpectedCode，实际为 $propVersionCode。"
    )
}

val overrideVersionName = (project.findProperty("PRISM_VERSION_NAME") as String?)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
val overrideVersionCodeRaw = (project.findProperty("PRISM_VERSION_CODE") as String?)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
val overrideVersionCode = overrideVersionCodeRaw?.let { raw ->
    raw.toIntOrNull()
        ?: throw GradleException("PRISM_VERSION_CODE 不是整数：[$raw]")
}

val prismVersionName = normalizeVersionName(
    overrideVersionName ?: propVersionName,
    "PRISM_VERSION_NAME / android/version.properties"
)
val prismVersionCode = versionCodeFor(prismVersionName, "生效版本")
if (overrideVersionCode != null && overrideVersionCode != prismVersionCode) {
    throw GradleException(
        "PRISM_VERSION_CODE=$overrideVersionCode 与 versionName=$prismVersionName " +
            "按 major*10000+minor*100+patch 应为 $prismVersionCode。"
    )
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
        versionCode = prismVersionCode
        versionName = prismVersionName
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
    /* 导航：5 项底部导航 + 设置子页，saveState/restoreState 保留各页签状态。 */
    implementation("androidx.navigation:navigation-compose:2.8.3")
    /* 设置存储：DataStore Preferences（替换原来的 SharedPreferences 配置读写）。 */
    implementation("androidx.datastore:datastore-preferences:1.1.1")
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

/* CI 用：打印本次构建实际生效的 versionName / versionCode，避免资产文件名与 APK 内版本不一致。 */
tasks.register("printVersionName") {
    doLast { println(prismVersionName) }
}
tasks.register("printVersionCode") {
    doLast { println(prismVersionCode) }
}

/*
 * 版本自检任务：配置期已强校验，这里再提供显式的可调用任务（CI / 本地都能跑）。
 * `gradle :app:verifyVersion` 成功只代表 version.properties 与覆盖参数自洽；
 * tag 与 APK 内版本的最终一致性由 release.yml 用 aapt dump badging 再验一次。
 */
tasks.register("verifyVersion") {
    group = "verification"
    description = "校验 versionName / versionCode 单一来源与单调规则"
    doLast {
        println("versionName=$prismVersionName versionCode=$prismVersionCode")
    }
}
