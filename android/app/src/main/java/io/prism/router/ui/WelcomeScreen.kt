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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing

/**
 * 首启引导：填写面板地址 / 令牌后进入概览。
 *
 * 只做输入与校验，真正的保存与启动轮询由调用方（[io.prism.router.ui.navigation.PrismNavHost]）
 * 通过 [onConnect] 完成；「稍后设置」直接进概览，设置页仍可随时补填。
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

    fun submit() {
        val url = base.trim()
        when {
            url.isEmpty() -> error = "请填写面板地址，例如 http://192.168.100.1:8099"
            !url.startsWith("http://") && !url.startsWith("https://") ->
                error = "面板地址需要以 http:// 或 https:// 开头"
            else -> {
                error = null
                onConnect(url, token.trim())
            }
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .statusBarsPadding()
                .imePadding()
                .padding(horizontal = PrismSpacing.xl, vertical = PrismSpacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(Modifier.height(PrismSpacing.xl))
            Surface(
                modifier = Modifier.size(76.dp),
                shape = CircleShape,
                color = MaterialTheme.colorScheme.primary
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = Icons.Rounded.Router,
                        contentDescription = "棱镜路由",
                        tint = MaterialTheme.colorScheme.onPrimary,
                        modifier = Modifier.size(38.dp)
                    )
                }
            }
            Spacer(Modifier.height(PrismSpacing.xl))
            Text(
                text = "棱镜路由",
                style = MaterialTheme.typography.displaySmall,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            Text(
                text = "连接 OpenWrt 面板，实时掌握每一台设备、每一个应用的流量。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(PrismSpacing.xl + PrismSpacing.sm))

            SectionCard(
                title = "连接路由器",
                subtitle = "首次使用只需填写面板地址，令牌可留空",
                modifier = Modifier.fillMaxWidth()
            ) {
                OutlinedTextField(
                    value = base,
                    onValueChange = { base = it; error = null; testResult = null },
                    label = { Text("面板地址") },
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
                    modifier = Modifier.fillMaxWidth()
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
                    modifier = Modifier.fillMaxWidth()
                )

                if (error != null) {
                    Spacer(Modifier.height(PrismSpacing.sm))
                    Text(
                        text = error.orEmpty(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                if (testResult != null) {
                    Spacer(Modifier.height(PrismSpacing.sm))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Rounded.CheckCircle,
                            contentDescription = null,
                            tint = if (testResult.orEmpty().startsWith("连接成功")) {
                                semantics.success
                            } else {
                                MaterialTheme.colorScheme.error
                            },
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(Modifier.size(PrismSpacing.xs))
                        Text(
                            text = testResult.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (testResult.orEmpty().startsWith("连接成功")) {
                                semantics.success
                            } else {
                                MaterialTheme.colorScheme.error
                            }
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
            Button(
                onClick = { submit() },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
            ) {
                Text("连接并开始")
            }
            Spacer(Modifier.height(PrismSpacing.xs))
            TextButton(onClick = onSkip) {
                Text("稍后设置，先看看概览")
            }
            Spacer(Modifier.height(PrismSpacing.lg))
            Text(
                text = "本应用只读展示用量，不会修改路由器配置。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(PrismSpacing.xl))
        }
    }
}
