# 棱镜路由 · Android 原生客户端

Kotlin + Jetpack Compose 原生应用（**不含 WebView**），只读展示路由器「棱镜路由」面板的数据。

## 功能

- 概览：上下行实时速率、今日/本月流量、在线设备、Clash 连接数、24 点速率折线（Canvas 自绘）、节点/出口占比、健康与告警
- 设备：按名称/MAC/IP 搜索、接入方式、上下行速率、累计流量
- 应用：按域名的流量 Top、链路与设备数
- 设置：面板地址（默认 `http://192.168.100.1:8099`）、访问令牌、刷新间隔（5–300 秒）、测试连接
- 关于：分别显示 **App 版本** 与 **路由器插件版本**；检查更新直接请求 GitHub Releases，
  **不依赖路由器在线**，只比较 App 版本，APK 下载交给系统浏览器 / 下载器

数据来自路由器的只读 API `/cgi-bin/panel-api?what=state`，应用不修改任何路由器配置。

## 构建

需要 JDK 17+ 与 Android SDK（platform 35 / build-tools 35）。

```sh
cd android
echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew assembleDebug        # 或 gradle assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # 纯 JVM 单测（含 GitHub Releases mock JSON）
```

本仓库开发环境用免安装工具链构建（JDK 21 + cmdline-tools + Gradle 8.7），命令见提交说明。

## 版本与发版

App 版本唯一来源是 `android/version.properties`：

```properties
versionName=1.0.9
versionCode=10009
```

- `versionCode` 固定为 `major*10000 + minor*100 + patch`，minor / patch 必须 < 100，
  否则 Gradle 配置阶段直接失败；
- CI 可用 `-PPRISM_VERSION_NAME` / `-PPRISM_VERSION_CODE` 覆盖，但必须自洽；
- `./gradlew :app:verifyVersion` 可在本地自检；
- App 与路由器插件**独立发版**：App 用 `app-v<versionName>` tag，插件用 `v<plugin-version>`
  tag；App 更新只依赖 GitHub Releases 上带 `.apk` 的 release。

## 安装

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

或把 APK 传到手机点击安装（需允许「安装未知来源应用」）。

debug 包使用 Android 默认调试签名，仅用于内测；正式分发请用你自己的 keystore 签名 release 包。
