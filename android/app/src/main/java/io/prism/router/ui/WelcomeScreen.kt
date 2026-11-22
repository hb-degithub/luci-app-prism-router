package io.prism.router.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Router
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing

/**
 * 首启引导：填写路由器地址 / 令牌后进入概览。
 *
 * 只做输入与校验，真正的保存与启动轮询由调用方（[io.prism.router.ui.navigation.PrismNavHost]）
 * 通过 [onConnect] 完成；「稍后设置」直接进概览，设置页仍可随时补填。
 *
 * 布局分两层：
 * - 上方是可滚动内容（品牌 / 说明 / 输入卡 / 测试结果 / 只读说明）；
 * - 底部是固定的操作区（主按钮 + 次级按钮），始终可见，不随内容滚动。
 *
 * @param onTest 可选的连接测试；为空时隐藏「测试连接」按钮。
 */
@Composable
fun WelcomeScreen(
    defaultBaseUrl: String,
    onConnect: (String, String) -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier,
    defaultToken: String = "",
    onTest: ((String, String, (String) -> Unit) -> Unit)? = null
) {
    var base by rememberSaveable { mutableStateOf(defaultBaseUrl) }
    var token by rememberSaveable { mutableStateOf(defaultToken) }
    var showToken by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var testResult by rememberSaveable { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    val semantics = LocalPrismSemanticColors.current

    /*
     * 键盘抬起 / 窗口缩小时，固定操作区会把底部占掉，滚动视口随之变矮，聚焦中的输入框
     * 可能被操作区挡住。这里只在「视口高度变化」或「焦点切换」时，把当前输入框用
     * ScrollState 滚回视口内；用到的是 onSizeChanged / boundsInRoot / scrollTo 等稳定 API。
     */
    val density = LocalDensity.current
    val scrollState = rememberScrollState()
    var viewportHeight by remember { mutableStateOf(0) }
    var viewportCoords by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var baseFieldCoords by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var tokenFieldCoords by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var focusedField by remember { mutableStateOf(0) }

    LaunchedEffect(viewportHeight, focusedField) {
        if (focusedField == 0) return@LaunchedEffect
        val viewport = viewportCoords?.takeIf { it.isAttached } ?: return@LaunchedEffect
        val field = (if (focusedField == 1) baseFieldCoords else tokenFieldCoords)
            ?.takeIf { it.isAttached }
            ?: return@LaunchedEffect
        val viewportBounds = viewport.boundsInRoot()
        val fieldBounds = field.boundsInRoot()
        if (viewportBounds.height <= 0f) return@LaunchedEffect
        val margin = with(density) { PrismSpacing.sm.roundToPx() }
        val overflowBottom = fieldBounds.bottom - viewportBounds.bottom
        val overflowTop = viewportBounds.top - fieldBounds.top
        when {
            overflowBottom > 0f -> scrollState.scrollTo(
                (scrollState.value + overflowBottom.toInt() + margin).coerceAtLeast(0)
            )
            overflowTop > 0f -> scrollState.scrollTo(
                (scrollState.value - overflowTop.toInt() - margin).coerceAtLeast(0)
            )
        }
    }

    fun submit() {
        val url = base.trim()
        val validationError = welcomeInputError(url)
        error = validationError
        if (validationError == null) {
            onConnect(url, token.trim())
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
                        MaterialTheme.colorScheme.background,
                        MaterialTheme.colorScheme.background
                    )
                )
            )
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            /*
             * 可滚动区：只放 logo / 标题 / 说明 / 输入卡（含错误、测试结果、测试连接）/ 只读说明。
             * 顶部只加 statusBarsPadding；navigationBars 与 IME 交给底部操作区统一处理，
             * 避免同一份 inset 在两层各加一次。
             */
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .onSizeChanged { viewportHeight = it.height }
                    .onGloballyPositioned { viewportCoords = it }
                    .verticalScroll(scrollState)
                    .statusBarsPadding()
                    .padding(horizontal = PrismSpacing.xl)
                    .padding(top = PrismSpacing.sm, bottom = PrismSpacing.lg),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                /* 压缩首屏顶部留白：logo 64dp、标题沿用 displaySmall，间距比旧版小一档。 */
                Surface(
                    modifier = Modifier.size(64.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.primary
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = Icons.Rounded.Router,
                            contentDescription = "棱镜路由",
                            tint = MaterialTheme.colorScheme.onPrimary,
                            modifier = Modifier.size(32.dp)
                        )
                    }
                }
                Spacer(Modifier.height(PrismSpacing.sm))
                Text(
                    text = "棱镜路由",
                    style = MaterialTheme.typography.displaySmall,
                    color = MaterialTheme.colorScheme.onBackground,
                    textAlign = TextAlign.Center
                )
                Spacer(Modifier.height(PrismSpacing.xs))
                Text(
                    text = "连接 OpenWrt 路由器，实时掌握每一台设备、每一个应用的流量。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )
                Spacer(Modifier.height(PrismSpacing.md))

                SectionCard(
                    title = "连接路由器",
                    subtitle = "首次使用只需填写路由器地址，令牌可留空",
                    modifier = Modifier.fillMaxWidth()
                ) {
                    OutlinedTextField(
                        value = base,
                        onValueChange = { base = it; error = null; testResult = null },
                        label = { Text("路由器地址") },
                        placeholder = { Text("http://192.168.100.1:8099") },
                        leadingIcon = {
                            Icon(
                                imageVector = Icons.Rounded.Router,
                                contentDescription = null
                            )
                        },
                        singleLine = true,
                        isError = error != null,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Done
                        ),
                        keyboardActions = KeyboardActions(onDone = { submit() }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .onGloballyPositioned { baseFieldCoords = it }
                            .onFocusChanged { state ->
                                if (state.isFocused) {
                                    focusedField = 1
                                } else if (focusedField == 1) {
                                    focusedField = 0
                                }
                            }
                    )
                    Spacer(Modifier.height(PrismSpacing.md))
                    OutlinedTextField(
                        value = token,
                        onValueChange = { token = it; testResult = null },
                        label = { Text("访问令牌（可留空）") },
                        leadingIcon = {
                            Icon(
                                imageVector = Icons.Rounded.Key,
                                contentDescription = null
                            )
                        },
                        trailingIcon = {
                            IconButton(onClick = { showToken = !showToken }) {
                                Icon(
                                    imageVector = if (showToken) {
                                        Icons.Rounded.VisibilityOff
                                    } else {
                                        Icons.Rounded.Visibility
                                    },
                                    contentDescription = if (showToken) "隐藏令牌" else "显示令牌"
                                )
                            }
                        },
                        singleLine = true,
                        visualTransformation = if (showToken) {
                            VisualTransformation.None
                        } else {
                            PasswordVisualTransformation()
                        },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Done
                        ),
                        keyboardActions = KeyboardActions(onDone = { submit() }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .onGloballyPositioned { tokenFieldCoords = it }
                            .onFocusChanged { state ->
                                if (state.isFocused) {
                                    focusedField = 2
                                } else if (focusedField == 2) {
                                    focusedField = 0
                                }
                            }
                    )

                    if (error != null) {
                        Spacer(Modifier.height(PrismSpacing.sm))
                        Text(
                            text = error.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                    testResult?.let { result ->
                        val success = result.startsWith("连接成功")
                        val color = if (success) semantics.success else MaterialTheme.colorScheme.error
                        Spacer(Modifier.height(PrismSpacing.sm))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = if (success) {
                                    Icons.Rounded.CheckCircle
                                } else {
                                    Icons.Rounded.ErrorOutline
                                },
                                contentDescription = if (success) "连接成功" else "连接失败",
                                tint = color,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(Modifier.size(PrismSpacing.xs))
                            Text(
                                text = result,
                                style = MaterialTheme.typography.bodyMedium,
                                color = color
                            )
                        }
                    }

                    if (onTest != null) {
                        Spacer(Modifier.height(PrismSpacing.md))
                        OutlinedButton(
                            onClick = {
                                if (!testing) {
                                    testing = true
                                    testResult = null
                                    onTest(base.trim(), token.trim()) { result ->
                                        testing = false
                                        testResult = result
                                    }
                                }
                            },
                            enabled = !testing,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = PrismSize.touchTarget)
                        ) {
                            if (testing) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    strokeWidth = 2.dp
                                )
                                Spacer(Modifier.size(PrismSpacing.sm))
                            }
                            Text(if (testing) "正在测试…" else "测试连接")
                        }
                    }
                }

                Spacer(Modifier.height(PrismSpacing.lg))
                Text(
                    text = "本应用只读展示用量，不会修改路由器配置。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )
            }

            /* 固定操作区：主 / 次级按钮始终可见，不参与上方滚动。 */
            WelcomeActionBar(
                onConnect = { submit() },
                onSkip = onSkip
            )
        }
    }
}

/**
 * 首启页固定底部操作区。
 *
 * Insets 策略：
 * - 底部只加一次 `safeDrawingPadding`，同时覆盖系统导航栏与 IME，避免分别使用
 *   `navigationBarsPadding()` / `imePadding()` 在部分边到边设备上叠加留白；
 * - 宿主已消费的 Insets 会由 Compose 向子级传播，独立预览时也能避开系统栏；
 * - 上方滚动区不再加 IME padding，视口缩小时由焦点滚动逻辑把输入框带回可见范围。
 *
 * 两个动作固定竖排（窄屏 / 字体放大时也不会横排挤压或裁切），高度分别 >= 52dp / 48dp。
 */
@Composable
private fun WelcomeActionBar(
    onConnect: () -> Unit,
    onSkip: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(
            topStart = PrismRadius.large,
            topEnd = PrismRadius.large
        ),
        color = MaterialTheme.colorScheme.surface
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .safeDrawingPadding()
                .padding(horizontal = PrismSpacing.xl, vertical = PrismSpacing.md),
            verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)
        ) {
            Button(
                onClick = onConnect,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
            ) {
                Text("连接并开始")
            }
            TextButton(
                onClick = onSkip,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text("稍后设置，先看看概览")
            }
        }
    }
}

/**
 * 首启页地址校验：返回 null 表示可以发起连接。
 *
 * 抽成纯函数只为让单元测试能锁定文案与判定顺序，行为与旧版内联判断完全一致。
 */
internal fun welcomeInputError(baseUrl: String): String? {
    val url = baseUrl.trim()
    return when {
        url.isEmpty() -> "请填写路由器地址，例如 http://192.168.100.1:8099"
        !url.startsWith("http://") && !url.startsWith("https://") ->
            "路由器地址需要以 http:// 或 https:// 开头"
        else -> null
    }
}
