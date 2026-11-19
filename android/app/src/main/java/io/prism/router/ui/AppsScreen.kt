package io.prism.router.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.prism.router.data.AppHistory
import io.prism.router.data.MainViewModel
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtClock

/** 应用页的时间范围：今日（`state.apps`）或近 7 天（`apps_history`，近似值）。 */
private const val RANGE_TODAY = 0
private const val RANGE_7D = 1

/** 应用类别（按域名关键词归类，纯前端本地规则，不改数据层）。 */
private enum class AppCategory(val label: String) {
    VIDEO("视频"),
    SOCIAL("社交"),
    DOWNLOAD("下载"),
    SHOPPING("购物"),
    GAME("游戏"),
    OTHER("其他")
}

/** 关键词按顺序匹配，先命中先归；未命中一律归“其他”。 */
private val CategoryRules: List<Pair<AppCategory, List<String>>> = listOf(
    AppCategory.VIDEO to listOf(
        "youtube", "bilibili", "iqiyi", "youku", "netflix", "douyin", "tiktok", "twitch"
    ),
    AppCategory.SOCIAL to listOf(
        "wechat", "qq", "weibo", "telegram", "whatsapp", "instagram"
    ),
    AppCategory.DOWNLOAD to listOf(
        "github", "gitlab", "npm", "registry", "mirror", "download", "update"
    ),
    AppCategory.SHOPPING to listOf(
        "taobao", "jd", "pdd", "amazon"
    ),
    AppCategory.GAME to listOf(
        "steam", "epic", "riot", "netease"
    ),
    AppCategory.OTHER to emptyList()
)

private fun categoryOf(host: String): AppCategory {
    val h = host.lowercase()
    return CategoryRules.firstOrNull { (category, keywords) ->
        category != AppCategory.OTHER && keywords.any { h.contains(it) }
    }?.first ?: AppCategory.OTHER
}

private fun categoryColor(category: AppCategory): Color = when (category) {
    AppCategory.VIDEO -> Color(0xFFE53935)
    AppCategory.SOCIAL -> Color(0xFF1E88E5)
    AppCategory.DOWNLOAD -> Color(0xFF00897B)
    AppCategory.SHOPPING -> Color(0xFFF57C00)
    AppCategory.GAME -> Color(0xFF8E24AA)
    AppCategory.OTHER -> SubText
}

/**
 * 一张应用卡片需要的统一字段：今日与近 7 天共用类别筛选 / 统计，
 * 只在第二行展示上区分（今日显示设备数，近 7 天显示日均与出现天数）。
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

@Composable
fun AppsScreen(ui: UiState) {
    /*
     * 调用方（App.kt）不在本次改动范围，只传 ui；这里取 Activity 作用域的同一个
     * MainViewModel（MainActivity 用 by viewModels() 创建），仅用于「切到近 7 天」
     * 与「失败重试」时触发拉取。渲染仍然只依赖传入的 ui，不直接读 vm.ui。
     */
    val vm: MainViewModel = viewModel()
    var range by rememberSaveable { mutableIntStateOf(RANGE_TODAY) }
    var categoryIndex by rememberSaveable { mutableIntStateOf(0) }

    val categories = AppCategory.entries
    val rows = remember(range, ui.state?.apps, ui.apps7d) {
        if (range == RANGE_7D) {
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
    }
    val counts = remember(rows) {
        categories.associateWith { category -> rows.count { it.category == category } }
    }
    val totals = remember(rows) {
        categories.associateWith { category ->
            rows.filter { it.category == category }.sumOf { it.total }
        }
    }
    val selectedCategory =
        if (categoryIndex in 1..categories.size) categories[categoryIndex - 1] else null
    val shown = if (selectedCategory == null) rows else rows.filter { it.category == selectedCategory }
    val totalBytes = rows.sumOf { it.total }
    /* 近 7 天视图在摘要前缀注明窗口，避免「合计」被误读成今日合计。 */
    val summary = buildString {
        if (range == RANGE_7D) append("近 7 天 · ")
        if (selectedCategory == null) {
            append("共 ${rows.size} 个域名 · 合计 ${fmtBytes(totalBytes)}")
        } else {
            append("「${selectedCategory.label}」${counts[selectedCategory] ?: 0} 个域名")
            append(" · 合计 ${fmtBytes(totals[selectedCategory] ?: 0)}")
        }
    }

    /* 首次进入近 7 天视图时补拉一次（ViewModel 内部有 5 分钟节流，不会重复请求）。 */
    LaunchedEffect(range) {
        if (range == RANGE_7D) vm.loadAppsHistory()
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        Text("应用流量 Top", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))

        SingleChoiceSegmentedButtonRow {
            SegmentedButton(
                selected = range == RANGE_TODAY,
                onClick = { range = RANGE_TODAY },
                shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                label = { Text("今日", fontSize = 13.sp) }
            )
            SegmentedButton(
                selected = range == RANGE_7D,
                onClick = { range = RANGE_7D },
                shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                label = { Text("近 7 天", fontSize = 13.sp) }
            )
        }
        Spacer(Modifier.height(8.dp))

        Text(summary, fontSize = 12.sp, color = SubText)
        if (range == RANGE_7D) {
            Spacer(Modifier.height(2.dp))
            Text(
                buildString {
                    append("基于每日 Top 50 汇总，非精确值")
                    if (ui.apps7dAt > 0L) append(" · 更新于 ${fmtClock(ui.apps7dAt)}")
                },
                fontSize = 11.sp,
                color = Warn
            )
            val error = ui.apps7dError
            when {
                error != null -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "近 7 天数据获取失败：$error",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.error,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(
                        onClick = { vm.loadAppsHistory(force = true) },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
                    ) {
                        Text("重试", fontSize = 12.sp)
                    }
                }

                ui.apps7dAt == 0L -> Text("正在加载近 7 天数据…", fontSize = 11.sp, color = SubText)
            }
        }
        Spacer(Modifier.height(8.dp))

        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                FilterChip(
                    selected = selectedCategory == null,
                    onClick = { categoryIndex = 0 },
                    label = { Text("全部 ${rows.size}", fontSize = 11.sp) }
                )
            }
            items(categories) { category ->
                FilterChip(
                    selected = selectedCategory == category,
                    onClick = { categoryIndex = category.ordinal + 1 },
                    label = { Text("${category.label} ${counts[category] ?: 0}", fontSize = 11.sp) }
                )
            }
        }
        Spacer(Modifier.height(10.dp))

        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(bottom = 16.dp)
        ) {
            items(shown) { row ->
                if (range == RANGE_7D) HistoryAppCard(row) else TodayAppCard(row)
            }
            if (shown.isEmpty()) {
                item {
                    Text(
                        when {
                            range != RANGE_7D && selectedCategory == null -> "暂无应用数据"
                            range != RANGE_7D -> "「${selectedCategory?.label}」暂无应用数据"
                            ui.apps7dError != null -> "近 7 天数据暂时不可用，可点上方「重试」。"
                            /* 首次拉取还没有结果：提示加载中，而不是「暂无数据」。 */
                            ui.apps7dAt == 0L -> "正在加载近 7 天数据…"
                            ui.apps7d.isEmpty() -> "近 7 天暂无应用数据（路由器可能还未生成每日摘要）。"
                            else -> "「${selectedCategory?.label ?: "全部"}」近 7 天暂无应用数据"
                        },
                        fontSize = 13.sp,
                        color = SubText,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }
}

/* ───────────────────────── 今日卡片（与原有布局一致） ───────────────────────── */

@Composable
private fun TodayAppCard(row: AppRow) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CategoryBadge(row.category)
                Spacer(Modifier.width(8.dp))
                Text(
                    row.host,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.width(8.dp))
                Text(fmtBytes(row.total), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(4.dp))
            Row {
                Text(if (row.chain.equals("DIRECT", true)) "直连" else row.chain, fontSize = 11.sp, color = Good)
                Spacer(Modifier.width(12.dp))
                Text("↓ ${fmtBytes(row.rx)}", fontSize = 11.sp, color = SubText)
                Spacer(Modifier.width(8.dp))
                Text("↑ ${fmtBytes(row.tx)}", fontSize = 11.sp, color = SubText)
                Spacer(Modifier.width(8.dp))
                Text("${row.devices} 台设备", fontSize = 11.sp, color = SubText)
            }
        }
    }
}

/* ───────────────────────── 近 7 天卡片 ───────────────────────── */

@Composable
private fun HistoryAppCard(row: AppRow) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CategoryBadge(row.category)
                Spacer(Modifier.width(8.dp))
                Text(
                    row.host,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.width(8.dp))
                Text(fmtBytes(row.total), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ChainBadge(row.chain)
                Spacer(Modifier.width(10.dp))
                Text("日均 ${fmtBytes(row.daily)}", fontSize = 11.sp, color = SubText, maxLines = 1)
                Spacer(Modifier.width(10.dp))
                Text("出现 ${row.days} 天", fontSize = 11.sp, color = SubText, maxLines = 1)
            }
            Spacer(Modifier.height(4.dp))
            Row {
                Text("↓ ${fmtBytes(row.rx)}", fontSize = 11.sp, color = SubText)
                Spacer(Modifier.width(12.dp))
                Text("↑ ${fmtBytes(row.tx)}", fontSize = 11.sp, color = SubText)
            }
        }
    }
}

/* ───────────────────────── 小组件 ───────────────────────── */

@Composable
private fun CategoryBadge(category: AppCategory) {
    val color = categoryColor(category)
    Box(
        Modifier
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp)
    ) {
        Text(category.label, fontSize = 10.sp, color = color, fontWeight = FontWeight.Medium)
    }
}

/** 出口链路徽章：DIRECT 显示「直连」，其余显示节点名（过长省略，避免 390px 溢出）。 */
@Composable
private fun ChainBadge(chain: String) {
    val normalized = chain.trim()
    val direct = normalized.equals("DIRECT", ignoreCase = true)
    val label = when {
        direct -> "直连"
        normalized.isEmpty() -> "未知链路"
        else -> normalized
    }
    val color = if (direct) Good else Brand
    Box(
        Modifier
            .widthIn(max = 110.dp)
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp)
    ) {
        Text(
            label,
            fontSize = 10.sp,
            color = color,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}
