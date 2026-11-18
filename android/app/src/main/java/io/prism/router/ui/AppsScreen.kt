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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import io.prism.router.data.AppUsage
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes

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

@Composable
fun AppsScreen(ui: UiState) {
    val apps = ui.state?.apps ?: emptyList()
    var categoryIndex by rememberSaveable { mutableIntStateOf(0) }

    val categories = AppCategory.entries
    val categorized = remember(apps) { apps.map { it to categoryOf(it.host) } }
    val counts = remember(categorized, categories) {
        categories.associateWith { category -> categorized.count { it.second == category } }
    }
    val totals = remember(categorized, categories) {
        categories.associateWith { category ->
            categorized.filter { it.second == category }.sumOf { it.first.total }
        }
    }
    val selectedCategory =
        if (categoryIndex in 1..categories.size) categories[categoryIndex - 1] else null
    val shown = if (selectedCategory == null) categorized else categorized.filter { it.second == selectedCategory }
    val totalBytes = categorized.sumOf { it.first.total }
    val summary = if (selectedCategory == null) {
        "共 ${categorized.size} 个域名 · 合计 ${fmtBytes(totalBytes)}"
    } else {
        "「${selectedCategory.label}」${counts[selectedCategory] ?: 0} 个域名 · 合计 ${fmtBytes(totals[selectedCategory] ?: 0)}"
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        Text("应用流量 Top", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(summary, fontSize = 12.sp, color = SubText)
        Spacer(Modifier.height(8.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                FilterChip(
                    selected = selectedCategory == null,
                    onClick = { categoryIndex = 0 },
                    label = { Text("全部 ${categorized.size}", fontSize = 11.sp) }
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
            items(shown) { (app, category) -> AppCard(app, category) }
            if (shown.isEmpty()) {
                item {
                    Text(
                        if (selectedCategory == null) "暂无应用数据" else "「${selectedCategory.label}」暂无应用数据",
                        fontSize = 13.sp,
                        color = SubText,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun AppCard(a: AppUsage, category: AppCategory) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CategoryBadge(category)
                Spacer(Modifier.width(8.dp))
                Text(
                    a.host,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.width(8.dp))
                Text(fmtBytes(a.total), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(4.dp))
            Row {
                Text(if (a.chain.equals("DIRECT", true)) "直连" else a.chain, fontSize = 11.sp, color = Good)
                Spacer(Modifier.width(12.dp))
                Text("↓ ${fmtBytes(a.rx)}", fontSize = 11.sp, color = SubText)
                Spacer(Modifier.width(8.dp))
                Text("↑ ${fmtBytes(a.tx)}", fontSize = 11.sp, color = SubText)
                Spacer(Modifier.width(8.dp))
                Text("${a.devices} 台设备", fontSize = 11.sp, color = SubText)
            }
        }
    }
}

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
