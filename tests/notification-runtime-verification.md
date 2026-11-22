# Android 通知与后台存活验证报告

> 范围：`android/` 本地告警通知实现。产品源码只读；本次只新增
> `android/app/src/test/java/io/prism/router/notify/AlertsNotifierTest.kt` 与本报告。
> 未修改 Manifest / Gradle / 产品代码，未 commit / push，未联网安装依赖。

- 验证时间：2026-11-22 11:26–12:00（Asia/Shanghai）
- 工作区：`/home/hb/openwrt用量统计插件`（`master` @ `15c5ba3`）
- JDK 21（`/home/hb/tools/jdk`），Android SDK 35（`/home/hb/tools/android/sdk`）
- 模拟器：API 35 google_apis x86_64（AVD `prism`），**软件加速 TCG（无 KVM）**，headless

## 0. 结论速览

| 待验证项 | 结论 | 证据级别 |
| --- | --- | --- |
| 通知是本地告警还是远程 push | **纯本地**：由轮询结果 `computeAlerts()` 触发，`AlertsNotifier` 无任何网络 IO | 静态 + 运行时 |
| 是否存在 FCM / WorkManager / 前台服务 / Alarm / BOOT 接收器 | **全部不存在** | 静态（源码 + 合并 Manifest + 依赖） |
| API 33+ 通知权限请求 | 首次启动触发系统 `GrantPermissionsActivity`；授权后 `granted=true`；"只问一次"标记落盘 | 运行时 |
| 渠道重要性 | `prism_alerts`，`mImportance=3`（`IMPORTANCE_DEFAULT`） | 运行时 |
| 锁屏可见性 | 通知 `vis=PRIVATE`，渠道 `mLockscreenVisibility=-1000`（NO_OVERRIDE）；即默认在锁屏显示、安全锁屏开"隐藏敏感内容"时正文隐藏；**非 PUBLIC** | 运行时属性 |
| 通知点击动作 | `contentIntent` 为 `startActivity` 的 PendingIntent，代码指向 `MainActivity`（`IMMUTABLE|UPDATE_CURRENT`，`NEW_TASK|CLEAR_TOP|SINGLE_TOP`） | 静态 + 系统记录 |
| 去重 / 24h 窗口 | 同 key（严重度+目标页+标题）24h 内不重复；`detail` 变化不产生新 key；去重记录已落盘，重启后的实际抑制未复测 | 运行时 + 落盘文件（跨进程抑制未完整复测） |
| 同时最多 3 条 | `MAX_ACTIVE=3`，超出从最早开始 `cancel`；实测 4 条告警只留 3 条 | 运行时 |
| 主轮询作用域 | `viewModelScope` 内的 `while(isActive)`；`stop()` 只取消 Job，`onCleared()` 才整体停止 | 静态 + 运行时 |
| 进程被 kill 后 | **没有任何定时/推送/恢复任务**：不再轮询、无 JobScheduler/Alarm/Service；告警通知不会自行产生 | 运行时 |
| 通知开关本地持久化 | 写入/读取路径均在 DataStore（`notifyEnabled`）；设备文件确认该键存在 | 静态 + 落盘文件（**未在设备上实际点击开关**） |

**一句话**：这是"App 进程存活时轮询 → 本地算告警 → 本地发通知"的实现；没有远程推送，也没有任何进程死后把 App 唤醒继续轮询的机制。因此不能把本实现描述成"后台保活/后台通知"。

## 1. 静态核对

### 1.1 Manifest / 依赖

- `android/app/src/main/AndroidManifest.xml:4-7`：仅 `INTERNET`、`ACCESS_NETWORK_STATE`、
  `POST_NOTIFICATIONS` 三个权限；`application` 内只有一个 `MainActivity`（`:18-27`），
  **无 `<service>`、无 `<receiver>`、无 FCM/Boot 相关声明**。
- 合并后的 Manifest（`android/app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml`）
  中唯一的 `<receiver>` 是 `androidx.profileinstaller.ProfileInstallReceiver`
  （Baseline Profile 安装器，需要 `android.permission.DUMP`），与告警/后台无关；
  另有 debug 专用的 `PreviewActivity`。
- `android/app/build.gradle.kts:56-77`：依赖里没有 `firebase-messaging`、`work-runtime`、
  `androidx.work`、`lifecycle-service` 等；全部源码 grep `WorkManager|Firebase|startForeground|JobScheduler|AlarmManager|BOOT_COMPLETED|WakeLock` 为 **0 命中**。
- 结论：**不存在远程推送通道，也不存在系统级后台调度组件。**

### 1.2 告警来源与发送

- `android/app/src/main/java/io/prism/router/data/AlertRules.kt:35-130`：`computeAlerts(state, nowSec)`
  是纯函数，输入面板快照，输出 `danger/warn/info` 三类告警；阈值：数据陈旧 90s、离线 600s、
  配额 80%/100%、未知接入 >3 台。
- `android/app/src/main/java/io/prism/router/data/MainViewModel.kt:409-433`：每轮 `refreshState()`
  成功后计算 `alerts`，仅当 `alerts != ui.alerts` 且非空时调用 `notifyAlerts(alerts)`。
- `MainViewModel.kt:1228-1235`：`notifyAlerts()` 先看 `notifyEnabled`，再调用
  `container.alertsNotifier.notifyIfNeeded(getApplication(), alerts)`；异常全部吞掉。
- `android/app/src/main/java/io/prism/router/notify/AlertsNotifier.kt:58-115`：
  只保留 `DANGER/WARN`（`:62-64`），无网络调用；`ensureChannel` 后按 24h 去重发送，
  最多保留 `MAX_ACTIVE=3` 条（`:99-107`）。

### 1.3 权限请求（API 33+）

- `android/app/src/main/java/io/prism/router/MainActivity.kt:147-176`：
  `RequestNotificationPermissionOnce()` 只在 `SDK_INT >= TIRAMISU` 生效；
  已授权直接返回；`SharedPreferences("prism-router").getBoolean("notifyPermissionAsked")`
  为 true 则不再请求；请求前先写标记，再 `launcher.launch(POST_NOTIFICATIONS)`。
- 拒绝/系统异常均静默，不影响页面与刷新。

### 1.4 渠道 / PendingIntent / 可见性

- `AlertsNotifier.kt:132-144`：渠道 id `prism_alerts`，名称 `棱镜路由告警`，
  `IMPORTANCE_DEFAULT`，`setShowBadge(true)`；**已存在则不重建**（保留用户改过的重要性）。
- `AlertsNotifier.kt:147-176`：`NotificationCompat.Builder` 设置
  `setContentIntent(PendingIntent.getActivity(..., FLAG_UPDATE_CURRENT or FLAG_IMMUTABLE))`、
  `setAutoCancel(true)`、`setOnlyAlertOnce(true)`、`setWhen(now)`、红/橙 color；
  **没有调用 `setVisibility(...)`** → 默认 `VISIBILITY_PRIVATE`；
  **没有调用 `setCategory` / `setPublicVersion` / `setFullScreenIntent`**。
- 点击目标：`Intent(context, MainActivity::class.java)` + `NEW_TASK|CLEAR_TOP|SINGLE_TOP`。

### 1.5 去重与时间戳

- key = `"${severity.name}|${target.name}|${title}"`（`AlertsNotifier.kt:179-180`），
  **不含 detail**；因此"数据陈旧"里每轮变化的秒数、"配额接近上限"里不同设备名
  都不会造成重复通知（同一标题只通知第一条）。
- 去重记录写入独立 SharedPreferences `prism-router-alerts`（`PREF_NAME`），
  键 `seen_<hash>` + `shown_ids`；`DEDUPE_MS = 24h`；`pruneSeen` 清理过期项。
- 通知 id 由 key hash 稳定派生（`:183-186`），同 key 覆盖而非叠加。
- 注意：`notify()` 被系统静默丢弃时也会记录 seen（`:93-94` 注释），属于"避免每轮重试"的取舍。

### 1.6 轮询作用域与进程生命周期

- `MainViewModel.kt:336-353`：`startPolling()` 在 `viewModelScope.launch { while (isActive) { refreshState(); delay(interval) } }`。
- `stop()`（`:355-376`）取消主轮询与所有子 Job；`onCleared()`（`:1489-1493`）调用 `stop()`。
- `ui/App.kt:97`：`LaunchedEffect(Unit) { vm.start() }`（进入主界面启动轮询）。
- 后台存活期：Activity 进后台不会调用 `stop()`，进程存活时 `viewModelScope` 继续跑；
  **进程被系统杀死后协程随之消失，没有任何恢复入口**。
- 全仓无 `WorkManager`/`AlarmManager`/`JobScheduler`/前台服务/BOOT 广播，
  因此"进程死后继续通知"在结构上不可能。

## 2. JVM 单元测试

命令（离线，不联网安装）：

```bash
cd android
JAVA_HOME=/home/hb/tools/jdk PATH=/home/hb/tools/jdk/bin:$PATH \
ANDROID_HOME=/home/hb/tools/android/sdk ANDROID_SDK_ROOT=/home/hb/tools/android/sdk \
./gradlew :app:testDebugUnitTest --offline --console=plain
```

结果：**87 tests, 0 failures, 0 errors, 0 skipped**（原有 75 + 新增 12）。

- 原有：`AlertsTest` 23、`ConfigClientParseTest` 10、`FormatTest` 15、
  `PanelClientParseTest` 12、`UpdateCheckParseTest` 8、`DeviceRouteCodecTest` 4、
  `WelcomeValidationTest` 3 = 75。
- 新增 `android/app/src/test/java/io/prism/router/notify/AlertsNotifierTest.kt`（12 个，纯 JVM）：
  - 常量契约：`CHANNEL_ID="prism_alerts"`、`DEDUPE_MS=24h`、`MAX_ACTIVE=3`；
  - `dedupeKey` 只由严重度/目标页/标题决定，detail 变化不改变 key；
  - `notificationId` 稳定、非 0、同 key 同 id、跨进程可复现；
  - 与 `computeAlerts` 组合：两台设备同时 80% 配额 → 同 key（只通知一条）；
    "数据陈旧" 两轮 detail 不同但 key 相同；INFO 告警确实由规则产出。
- 说明：`notifyIfNeeded` 的权限检查、渠道创建、`NotificationManager.notify/cancel`、
  PendingIntent、SharedPreferences 落盘依赖 Android 框架，当前工程**没有 Robolectric**，
  且禁止改 Gradle，因此这些只能在模拟器上验证（见第 3 节）；JVM 测试不冒充覆盖。

## 3. 模拟器运行验证

### 3.1 环境与启动

机器有 `/dev/kvm`，但当前用户 `hb` 不在 `kvm` 组且无 ACL（`crw-rw----+ root:kvm`，
`sudo` 需要交互密码，审批禁用无法提权）。因此只能用软件模拟：

```bash
emulator -avd prism -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -accel off -no-snapshot -no-snapshot-save -port 5556
```

- 冷启动约 8–10 分钟；期间 `system_server` 被 Watchdog 杀过一次（TCG 太慢），
  重启后最终 `sys.boot_completed=1`。
- 之后 SystemUI 仍多次 ANR；`uiautomator dump` 返回 `null root node` 或进程被 kill，
  `screencap` 全黑（15580 字节纯黑 PNG）。因此**无法做可靠的 UI 点击/截图断言**。

为避免连真实路由器，全程只访问本机假面板：

- 宿主机 Python 假面板监听 `127.0.0.1:18099`，返回 `?what=state` 构造数据；
- `adb reverse tcp:18099 tcp:18099`；
- 用 `run-as` 预置旧 SharedPreferences `baseUrl=http://127.0.0.1:18099`（**无 token**），
  首次启动迁移到 DataStore；
- 三个场景：`single`（仅"记账不可用"）、`none`（健康）、`multi`（记账不可用/数据源不可用/
  数据陈旧/设备离线共 4 条）。

### 3.2 权限请求（API 33）

- 首次 `am start` 后，`dumpsys activity activities` 顶层为：
  `topResumedActivity=com.google.android.permissioncontroller/...GrantPermissionsActivity`
  → 系统权限对话框确实被拉起。
- `dumpsys package io.prism.router`：请求前 `POST_NOTIFICATIONS: granted=false`；
  `pm grant` 后 `granted=true, flags=[USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]`。
- 旧 prefs 文件出现 `<boolean name="notifyPermissionAsked" value="true" />`，
  证明"只问一次"标记落盘（拒绝后是否不再弹未在设备上复测，仅代码路径成立）。

### 3.3 渠道与通知内容

`dumpsys notification --noredact` 实测：

```text
NotificationRecord(... pkg=io.prism.router ... importance=3
  channel=prism_alerts ... flags=ONLY_ALERT_ONCE|AUTO_CANCEL color=0xffe5484d vis=PRIVATE)
...
effectiveNotificationChannel=NotificationChannel{mId='prism_alerts', mName=棱镜路由告警,
  mImportance=3, mBypassDnd=false, mLockscreenVisibility=-1000, mShowBadge=true, ...}
...
contentIntent=PendingIntent{... io.prism.router startActivity (...)}
android.title=String (记账不可用)
android.text=String (记账可信度为「不可用」，流量分账结果可能缺失。)
when=1795319237454
```

- 渠道 `mImportance=3` = `IMPORTANCE_DEFAULT`；`mLockscreenVisibility=-1000`
  （`VISIBILITY_NO_OVERRIDE`）；通知 `vis=PRIVATE`（0）。
- 含义：默认在锁屏可见；若用户在安全锁屏开启"隐藏敏感内容"，正文会被隐藏；
  不是 PUBLIC，也没有 `setPublicVersion` 的公开替身。
- 颜色随严重度：DANGER `0xffe5484d`，WARN `0xfff5a524`。

### 3.4 去重（含 detail 变化）

1. 先以 `single` 发出 1 条“记账不可用”，记录 `mUpdateTimeMs=1795319240407`；
2. 切到 `none` 等一轮（代码不会因 alerts 为空而撤销既有通知），再切回 `single`；
3. 连续 3 次 `single` 轮询（11:48:37 / 11:48:51 / 11:49:06）后，应用侧仍只有 **1 条**记录，
   `mUpdateTimeMs` 仍为 `1795319240407`；
4. 随后才执行下面的 `multi` 场景，应用侧通知变为 3 条。

→ 24h 去重生效；`detail` 里秒数变化不会造成重复通知。落盘文件
`shared_prefs/prism-router-alerts.xml` 含 `seen_*` 时间戳与 `shown_ids`，
说明去重状态已持久化；重启后的实际通知抑制没有完整复测，见 3.6 的限制说明。

### 3.5 最多 3 条与"撤最早"

切到 `multi`（4 条告警）后，应用侧通知记录为 **3 条**（系统自动分组的
`ranker_group` 摘要记录不计入应用自己的 `notify`）：

```text
设备离线 / 数据陈旧 / 数据源不可用        （各 1 条）
```

最早的"记账不可用"被 `cancel` 掉 → `MAX_ACTIVE=3` 与"从最早开始撤"生效。

### 3.6 后台与进程死亡

- 按 HOME 退到桌面后，进程仍存活，假面板继续收到轮询：
  `11:50:21 / 11:50:37 / 11:50:51`（约 15s 一次）。
  → 只要进程还在，轮询在后台继续（`viewModelScope` 不受 Activity 前后台影响）。
- 随后系统在内存压力下杀掉了 App 进程（`pidof` 为空）；从 `11:50:51` 起
  **假面板再无任何请求**（11:55:41 复查仍无）。
- 进程死亡后检查：
  - `dumpsys jobscheduler`：无 `io.prism.router` 注册的 job（只有 standby bucket
    "Stopped packages" 记录与 `TopAppTimer NOT active`）；
  - `dumpsys alarm`：无 `io.prism.router` 条目；
  - `dumpsys activity services`：无 `io.prism.router` 服务；
  - 系统通知栏仍保留已发出的 3 条通知（通知归 SystemUI 管理，不随进程消失）。
- 重启 App 后 `MainActivity` 正常恢复，权限对话框未再出现；截至观测结束未产生新通知
  （去重状态仍在），但由于 TCG 下重启后轮询迟迟未发起，这条只作为辅助证据。

→ **进程死后既不会继续轮询，也没有任何系统任务把它唤醒**；不存在"后台保活"。

## 4. 未能验证 / 明确限制

1. **通知开关端到端点击**：`notifyEnabled` 的写入（`MainActivity.kt:112-117` →
   `SettingsStore.setNotifyEnabled` → DataStore）与读取/拦截（`applySettings` →
   `MainViewModel.notifyAlerts`）均为代码核对；设备上只确认 DataStore 文件
   `files/datastore/prism_settings.preferences_pb` 中存在 `notifyEnabled` 键（默认 true）。
   因 UI 自动化不可用（见 3.1），**没有在设备上实际点开关再重启验证**。
2. **通知点击动作**：系统记录 `contentIntent=... startActivity` + 代码指向
   `MainActivity`，但由于 `uiautomator` 返回 null root、截图为全黑，**没有实际点击通知**。
3. **锁屏视觉验证**：没有配置安全锁屏，也无法截图；只验证了
   `vis=PRIVATE` / 渠道 `VISIBILITY_NO_OVERRIDE` 这两个决定锁屏表现的系统属性。
4. **拒绝权限后的行为**：只验证了"授权"路径；拒绝/不再询问仅代码路径成立。
5. **长时间 Doze / 厂商省电策略**：未做；本实现没有任何前台服务/白名单申请，
   系统在 Doze 或厂商冻结时可能延迟/停止进程内轮询。
6. 模拟器本身不稳定（无 KVM、Watchdog、SystemUI ANR），以上运行时结论只覆盖
   "观测到的时间窗"，不是长稳测试。

## 5. 复现方式（要点）

```bash
# 1) JVM 测试
cd android && JAVA_HOME=/home/hb/tools/jdk PATH=/home/hb/tools/jdk/bin:$PATH \
  ANDROID_HOME=/home/hb/tools/android/sdk ANDROID_SDK_ROOT=/home/hb/tools/android/sdk \
  ./gradlew :app:testDebugUnitTest --offline

# 2) 模拟器（需要可用 KVM 才实用）
emulator -avd prism -no-window -no-audio -accel off ...
adb install -t app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:18099 tcp:18099
# 预置 baseUrl=http://127.0.0.1:18099 的旧 prefs，首次启动迁移
adb shell am start -W -n io.prism.router/.MainActivity
adb shell dumpsys notification --noredact
adb shell dumpsys jobscheduler | grep -i prism
adb shell dumpsys alarm | grep -i prism
```

本次使用的假面板脚本在 `/tmp/prism_fake_panel.py`（临时文件，未入库），
场景通过 `/tmp/prism_panel_mode`（none/single/multi）切换；验证结束后模拟器已
`adb emu kill` 关闭，假面板进程已终止，端口 18099 已释放。

## 6. 变更与提交

- 新增：`android/app/src/test/java/io/prism/router/notify/AlertsNotifierTest.kt`
- 新增：本报告
- 未修改任何产品源码 / Manifest / Gradle；未 commit / push。
