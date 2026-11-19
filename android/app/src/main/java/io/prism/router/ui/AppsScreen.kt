package io.prism.router.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Apps
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.prism.router.data.AppHistory
import io.prism.router.data.MainViewModel
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.ui.components.EmptyState
import io.prism.router.ui.components.ErrorState
import io.prism.router.ui.components.Pill
import io.prism.router.ui.components.PrismIconAction
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.Segmented
import io.prism.router.ui.components.SkeletonList
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * 应用屏（商用风格重做）：大标题 + 今日/近 7 天 + 类别筛选 + 应用卡片 + 口径提示。
 * 只组合 ui/components 现有组件与主题令牌，不新增共享组件。
 */

/* ───────────────────────── 页面常量 ───────────────────────── */

/** 应用页的时间范围：今日（`state.apps`）或近 7 天（`apps_history`，近似值）。 */
private const val RANGE_TODAY = 0
private const val RANGE_7D = 1

private val AppRanges = listOf(RANGE_TODAY, RANGE_7D)

/** 下拉刷新看门狗：请求异常卡住时最多转 8 秒，避免指示器永久停在顶部。 */
private const val REFRESH_WATCHDOG_MS = 8_000L

/** 域名 / 速率等机器可读串的等宽样式（域名长，字号比设备页略大）。 */
private val MonoCaption = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 11.sp,
    lineHeight = 15.sp,
    letterSpacing = 0.sp
)

/**
 * 应用类别（按域名关键词归类，纯前端本地规则，不改数据层）。
 *
 * 关键词顺序 = 归类优先级；先命中先归，未命中一律归「其他」。
 */
private enum class AppCategory(val label: String) {
    VIDEO("视频"),
    SOCIAL("社交"),
    DOWNLOAD("下载"),
    SHOPPING("购物"),
    GAME("游戏"),
    OTHER("其他")
}

private val CategoryRules: List<Pair<AppCategory, List<String>>> = listOf(
    AppCategory.VIDEO to listOf(
        "youtube", "bilibili", "iqiyi", "youku", "mgtv", "netflix", "disney",
        "douyin", "tiktok", "kuaishou", "twitch", "vimeo", "qq.com"
    ),
    AppCategory.SOCIAL to listOf(
        "wechat", "weixin", "weibo", "telegram", "whatsapp", "instagram",
        "facebook", "twitter", "discord", "messenger", "line.me"
    ),
    AppCategory.DOWNLOAD to listOf(
        "github", "gitlab", "npm", "registry", "mirror", "download", "update",
        "pypi", "docker", "cdn"
    ),
    AppCategory.SHOPPING to listOf(
        "taobao", "tmall", "jd.com", "pinduoduo", "amazon", "aliexpress",
        "shopee", "ebay"
    ),
    AppCategory.GAME to listOf(
        "steam", "epicgames", "riot", "netease", "blizzard", "battle.net",
        "playstation", "xbox", "game"
    ),
    AppCategory.OTHER to emptyList()
)

private fun categoryOf(host: String): AppCategory {
    val h = host.lowercase()
    return CategoryRules.firstOrNull { (category, keywords) ->
        category != AppCategory.OTHER && keywords.any { h.contains(it) }
    }?.first ?: AppCategory.OTHER
}

/** 类别配色：全部取主题色，深浅色自适应，不写死十六进制。 */
@Composable
private fun categoryColor(category: AppCategory): Color {
    val semantic = LocalPrismSemanticColors.current
    return when (category) {
        AppCategory.VIDEO -> MaterialTheme.colorScheme.error
        AppCategory.SOCIAL -> MaterialTheme.colorScheme.primary
        AppCategory.DOWNLOAD -> MaterialTheme.colorScheme.secondary
        AppCategory.SHOPPING -> semantic.warning
        AppCategory.GAME -> MaterialTheme.colorScheme.tertiary
        AppCategory.OTHER -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

/**
 * 一张应用卡片需要的统一字段：今日与近 7 天共用类别筛选 / 统计，
 * 只在第二、三行展示上区分（今日显示设备数，近 7 天显示合计 / 日均 / 出现天数）。
 */
private data class AppRow(
    val host: String,
    val rx: Long,
    val tx: Long,
    val chain: String,
    val category: AppCategory,
    val days: Int,
    val devices: Int,
    /** 近 7 天视图的日均（今日视图不用，置 0）。口径见 [AppHistory.dailyAvg]。 */
    val daily: Long
) {
    val total: Long get() = rx + tx
}

/**
 * 应用页。
 *
 * 结构：PrismScaffold（大标题「应用」+ 域名数 / Top 50 副标题，滚动收起）
 * → 固定「今日 / 近 7 天」分段、Top 50 口径提示、类别筛选 → 可下拉刷新的应用列表。
 *
 * 今日数据来自 `state.apps`；近 7 天数据来自 `apps7d`（每日 Top 50 汇总，近似值，
 * 界面上必须如实标注）。切到近 7 天时调用 ViewModel 现有 [MainViewModel.loadAppsHistory]
 * （内部 5 分钟节流），类别筛选在两个范围之间保持不变。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppsScreen(
    ui: UiState,
    /*
     * Activity 作用域的 MainViewModel：仅用于「切到近 7 天」与「失败重试」触发拉取，
     * 渲染仍然只依赖传入的 ui。NavHost 会显式传入；默认值兜底旧调用方，且避免
     * viewModel() 落到 NavBackStackEntry 上新建第二个实例（见 appsViewModel 注释）。
     */
    vm: MainViewModel = appsViewModel()
) {
    var range by rememberSaveable { mutableIntStateOf(RANGE_TODAY) }
    /* 类别下标 0 = 全部；切换今日 / 近 7 天时保持不放。 */
    var categoryIndex by rememberSaveable { mutableIntStateOf(0) }
    var pulling by remember { mutableStateOf(false) }

    val sevenDay = range == RANGE_7D
    val categories = AppCategory.entries

    val rows = remember(range, ui.state?.apps, ui.apps7d) {
        val base = if (range == RANGE_7D) {
            ui.apps7d.map { app ->
                AppRow(
                    host = app.displayName,
                    rx = app.rx,
                    tx = app.tx,
                    chain = app.chain,
                    category = categoryOf(app.host),
                    days = app.days,
                    devices = 0,
                    daily = app.dailyAvg
                )
            }
        } else {
            ui.state?.apps.orEmpty().map { app ->
                AppRow(
                    host = app.host,
                    rx = app.rx,
                    tx = app.tx,
                    chain = app.chain,
                    category = categoryOf(app.host),
                    days = 0,
                    devices = app.devices,
                    daily = 0
                )
            }
        }
        /* 列表按流量降序：后端顺序不可依赖，前端兜一层保证「Top」语义。 */
        base.sortedByDescending { it.total }
    }
    val counts = remember(rows) {
        categories.associateWith { category -> rows.count { it.category == category } }
    }
    val selectedCategory =
        if (categoryIndex in 1..categories.size) categories[categoryIndex - 1] else null
    val shown = if (selectedCategory == null) {
        rows
    } else {
        rows.filter { it.category == selectedCategory }
    }
    val loadError = if (sevenDay) ui.apps7dError else ui.error
    val firstLoad = if (sevenDay) {
        ui.apps7dAt == 0L && ui.apps7dError == null
    } else {
        ui.state == null && ui.error == null
    }

    fun refreshApps() {
        pulling = true
        vm.refresh()
    }

    /** 下拉指示器跟随主数据 loading；另设看门狗兜底，网络卡住也不会永久转圈。 */
    LaunchedEffect(ui.loading, ui.updatedAt, ui.apps7dAt) {
        if (!ui.loading) pulling = false
    }
    LaunchedEffect(pulling) {
        if (pulling) {
            delay(REFRESH_WATCHDOG_MS)
            pulling = false
        }
    }

    /* 首次进入近 7 天视图时补拉一次（ViewModel 内部有 5 分钟节流，不会重复请求）。 */
    LaunchedEffect(range) {
        if (range == RANGE_7D) vm.loadAppsHistory()
    }

    PrismScaffold(
        title = "应用",
        subtitle = appsSubtitle(count = rows.size, sevenDay = sevenDay),
        actions = {
            PrismIconAction(
                icon = Icons.Rounded.Refresh,
                contentDescription = "刷新应用数据",
                onClick = { refreshApps() }
            )
        }
    ) { _ ->
        Column(Modifier.fillMaxSize()) {
            /* ── 固定头部：时间范围 / 口径提示 / 类别筛选 ── */
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = PrismSpacing.lg)
            ) {
                Spacer(Modifier.height(PrismSpacing.sm))
                Segmented(
                    options = AppRanges,
                    selected = range,
                    onSelect = { range = it },
                    label = { if (it == RANGE_7D) "近 7 天" else "今日" },
                    modifier = Modifier.fillMaxWidth()
                )
                if (sevenDay) {
                    Spacer(Modifier.height(PrismSpacing.sm))
                    Top50Notice(updatedAt = ui.apps7dAt)
                }
                Spacer(Modifier.height(PrismSpacing.sm))
                CategoryChips(
                    rows = rows,
                    counts = counts,
                    selected = selectedCategory,
                    onSelect = { categoryIndex = if (it == null) 0 else it.ordinal + 1 }
                )
                Spacer(Modifier.height(PrismSpacing.xs))
            }

            PullToRefreshBox(
                isRefreshing = pulling,
                onRefresh = { refreshApps() },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = PrismSpacing.lg,
                        end = PrismSpacing.lg,
                        top = PrismSpacing.sm,
                        bottom = PrismSpacing.xl
                    ),
                    verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
                ) {
                    /* 今日视图离线时给出缓存提示；近 7 天有旧结果但本次失败时给出内联错误。 */
                    if (!sevenDay && ui.offline) {
                        item { OfflineBanner(at = ui.offlineAt, onRetry = { refreshApps() }) }
                    }
                    if (sevenDay && ui.apps7dError != null && ui.apps7d.isNotEmpty()) {
                        item {
                            InlineErrorRow(
                                message = "近 7 天刷新失败：${ui.apps7dError}",
                                onRetry = { vm.loadAppsHistory(force = true) }
                            )
                        }
                    }

                    when {
                        /* 首屏失败：没有任何可展示数据 → 错误态 + 重试。 */
                        loadError != null && rows.isEmpty() && !firstLoad -> item {
                            Box(
                                Modifier
                                    .fillParentMaxSize()
                                    .padding(bottom = PrismSpacing.xl),
                                contentAlignment = Alignment.Center
                            ) {
                                ErrorState(
                                    msg = if (sevenDay) {
                                        "近 7 天数据获取失败：$loadError"
                                    } else {
                                        loadError
                                    },
                                    title = if (sevenDay) "近 7 天数据加载失败" else "应用数据加载失败",
                                    onRetry = {
                                        if (sevenDay) {
                                            vm.loadAppsHistory(force = true)
                                        } else {
                                            refreshApps()
                                        }
                                    }
                                )
                            }
                        }

                        firstLoad -> item {
                            SkeletonList(rows = 5, showHeader = false)
                        }

                        rows.isEmpty() -> item {
                            Box(
                                Modifier
                                    .fillParentMaxSize()
                                    .padding(bottom = PrismSpacing.xl),
                                contentAlignment = Alignment.Center
                            ) {
                                EmptyApps(sevenDay = sevenDay)
                            }
                        }

                        shown.isEmpty() -> item {
                            Box(
                                Modifier
                                    .fillParentMaxSize()
                                    .padding(bottom = PrismSpacing.xl),
                                contentAlignment = Alignment.Center
                            ) {
                                EmptyCategory(
                                    category = selectedCategory,
                                    sevenDay = sevenDay,
                                    onShowAll = { categoryIndex = 0 }
                                )
                            }
                        }

                        else -> items(shown) { row ->
                            AppCard(row = row, sevenDay = sevenDay)
                        }
                    }
                }
            }
        }
    }
}

/* ───────────────────────── 固定头部 ───────────────────────── */

/** 近 7 天口径提示：每日 Top 50 汇总不是精确全量，必须在顶部常驻。 */
@Composable
private fun Top50Notice(updatedAt: Long) {
    val warning = LocalPrismSemanticColors.current.warning
    val text = buildString {
        append("基于每日 Top 50 汇总，非精确值")
        if (updatedAt > 0L) {
            append(" · 更新于 ${fmtHm(updatedAt)}")
        } else {
            append(" · 正在加载…")
        }
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        color = warning.copy(alpha = 0.12f),
        contentColor = warning
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 40.dp)
                .padding(horizontal = PrismSpacing.md, vertical = PrismSpacing.sm),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Rounded.Info,
                contentDescription = null,
                tint = warning,
                modifier = Modifier.size(PrismSize.iconSmall)
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = text,
                style = MaterialTheme.typography.labelSmall,
                color = warning,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

/** 类别筛选：全部 + 6 类，带当前时间范围内的条目数；横向滚动避免 390dp 下挤压。 */
@Composable
private fun CategoryChips(
    rows: List<AppRow>,
    counts: Map<AppCategory, Int>,
    selected: AppCategory?,
    onSelect: (AppCategory?) -> Unit
) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm)) {
        item {
            CategoryChip(
                label = "全部 ${rows.size}",
                selected = selected == null,
                onClick = { onSelect(null) }
            )
        }
        items(AppCategory.entries) { category ->
            CategoryChip(
                label = "${category.label} ${counts[category] ?: 0}",
                selected = selected == category,
                onClick = { onSelect(category) }
            )
        }
    }
}

@Composable
private fun CategoryChip(label: String, selected: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, style = MaterialTheme.typography.labelSmall) },
        shape = RoundedCornerShape(PrismRadius.pill),
        colors = FilterChipDefaults.filterChipColors(
            containerColor = MaterialTheme.colorScheme.surface,
            labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
            selectedContainerColor = MaterialTheme.colorScheme.primary,
            selectedLabelColor = MaterialTheme.colorScheme.onPrimary
        )
    )
}

/* ───────────────────────── 应用卡片 ───────────────────────── */

/**
 * 商用风格应用行：
 * - 第一行：类别徽章 + 域名（等宽、过长省略）+ 今日合计；
 * - 第二行：链路 Pill（DIRECT 绿）+ 下行 / 上行 + 设备数（今日）或出现天数（7 天）；
 * - 第三行（仅近 7 天）：合计 / 日均 / 出现天数。
 */
@Composable
private fun AppCard(row: AppRow, sevenDay: Boolean) {
    val categoryAccent = categoryColor(row.category)
    val shape = MaterialTheme.shapes.medium

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        color = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
        tonalElevation = 0.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = PrismSpacing.md, vertical = PrismSpacing.md)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pill(
                    text = row.category.label,
                    color = categoryAccent,
                    leadingDot = false
                )
                Spacer(Modifier.width(PrismSpacing.sm))
                Text(
                    text = row.host,
                    style = MaterialTheme.typography.bodyMedium.copy(
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Medium,
                        fontSize = 13.sp
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (!sevenDay) {
                    Spacer(Modifier.width(PrismSpacing.sm))
                    Text(
                        text = fmtBytes(row.total),
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp
                        ),
                        maxLines = 1
                    )
                }
            }

            Spacer(Modifier.height(PrismSpacing.xs))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ChainPill(row.chain)
                Spacer(Modifier.width(PrismSpacing.sm))
                Text(
                    text = "↓ ${fmtBytes(row.rx)}",
                    style = MonoCaption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
                Spacer(Modifier.width(PrismSpacing.sm))
                Text(
                    text = "↑ ${fmtBytes(row.tx)}",
                    style = MonoCaption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
                Spacer(Modifier.weight(1f))
                if (!sevenDay) {
                    Text(
                        text = "${row.devices} 台设备",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1
                    )
                }
            }

            if (sevenDay) {
                Spacer(Modifier.height(PrismSpacing.xs))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "合计 ${fmtBytes(row.total)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1
                    )
                    SeparatorDot()
                    Text(
                        text = "日均 ${fmtBytes(row.daily)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1
                    )
                    SeparatorDot()
                    Text(
                        text = "出现 ${row.days} 天",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1
                    )
                }
            }
        }
    }
}

@Composable
private fun SeparatorDot() {
    Text(
        text = "·",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
        modifier = Modifier.padding(horizontal = PrismSpacing.xs)
    )
}

/**
 * 出口链路 Pill：`DIRECT` 用 success 绿（显示「直连」），其余非空链路用 primary 蓝。
 * 缺失显示「—」并置灰——不冒充代理。
 */
@Composable
private fun ChainPill(chain: String) {
    val normalized = chain.trim()
    val semantic = LocalPrismSemanticColors.current
    val color = when {
        normalized.isEmpty() -> MaterialTheme.colorScheme.onSurfaceVariant
        normalized.equals("DIRECT", ignoreCase = true) -> semantic.success
        else -> MaterialTheme.colorScheme.primary
    }
    Pill(
        text = when {
            normalized.isEmpty() -> "—"
            normalized.equals("DIRECT", ignoreCase = true) -> "直连"
            normalized.equals("MIXED", ignoreCase = true) -> "混合"
            else -> normalized
        },
        color = color,
        leadingDot = false,
        modifier = Modifier.widthIn(max = 92.dp)
    )
}

/* ───────────────────────── 空态 / 错误提示 ───────────────────────── */

@Composable
private fun EmptyApps(sevenDay: Boolean) {
    EmptyState(
        icon = Icons.Rounded.Apps,
        title = if (sevenDay) "近 7 天暂无应用数据" else "暂无应用数据",
        desc = if (sevenDay) {
            "路由器可能还未生成每日摘要；产生流量后汇总会自动出现。"
        } else {
            "路由器还没有统计到域名用量，产生流量后会自动出现。"
        }
    )
}

@Composable
private fun EmptyCategory(
    category: AppCategory?,
    sevenDay: Boolean,
    onShowAll: () -> Unit
) {
    EmptyState(
        icon = Icons.Rounded.Search,
        title = "「${category?.label ?: "该类别"}」暂无应用",
        desc = if (sevenDay) {
            "近 7 天没有该类别流量，切回「全部」看看其他域名。"
        } else {
            "今日没有该类别流量，切回「全部」看看其他域名。"
        },
        action = {
            TextButton(onClick = onShowAll) { Text("查看全部") }
        }
    )
}

/** 近 7 天有旧数据、本次刷新失败：保留列表 + 内联重试，不清空已有结果。 */
@Composable
private fun InlineErrorRow(message: String, onRetry: () -> Unit) {
    val errorColor = MaterialTheme.colorScheme.error
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        color = errorColor.copy(alpha = 0.10f),
        contentColor = errorColor
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = PrismSize.touchTarget)
                .padding(start = PrismSpacing.md, end = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.labelSmall,
                color = errorColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = onRetry) {
                Text("重试", style = MaterialTheme.typography.labelSmall, color = errorColor)
            }
        }
    }
}

/** 今日视图离线快照提示：仍可下拉刷新；颜色取 warning，深浅色下都可读。 */
@Composable
private fun OfflineBanner(at: Long, onRetry: () -> Unit) {
    val warning = LocalPrismSemanticColors.current.warning
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        color = warning.copy(alpha = 0.12f),
        contentColor = warning
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = PrismSize.touchTarget)
                .padding(start = PrismSpacing.md, end = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "离线数据 · 更新于 ${fmtHm(at)}",
                style = MaterialTheme.typography.labelSmall,
                color = warning,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = onRetry) {
                Text("重试", style = MaterialTheme.typography.labelSmall, color = warning)
            }
        }
    }
}

/* ───────────────────────── 文案 / 工具 ───────────────────────── */

private fun appsSubtitle(count: Int, sevenDay: Boolean): String = if (sevenDay) {
    "$count 个域名 · 近 7 天按每日 Top 50 汇总"
} else {
    "$count 个域名 · 今日按域名统计"
}

/** 口径提示用的时:分格式（与「更新于 HH:mm」的中文习惯一致）。 */
private fun fmtHm(ts: Long): String {
    if (ts <= 0) return "—"
    return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
}

/**
 * 取 Activity 作用域的 MainViewModel（与 MainActivity 的 `by viewModels()` 是同一个实例）。
 *
 * Navigation-Compose 会把每个目的地的 LocalViewModelStoreOwner 换成 NavBackStackEntry，
 * 此时直接 `viewModel()` 会创建另一个 MainViewModel：loadAppsHistory() 只写进那个
 * 没人渲染的实例，切到近 7 天会一直「正在加载」。这里显式用宿主 Activity 作为 owner；
 * 非 Activity 宿主（预览 / 测试）回退默认 owner。
 */
@Composable
private fun appsViewModel(): MainViewModel {
    val activity = LocalContext.current as? ComponentActivity
    return if (activity != null) {
        viewModel(viewModelStoreOwner = activity)
    } else {
        viewModel()
    }
}
