package io.prism.router.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Brand = Color(0xFF3B5BFF)
val Good = Color(0xFF00B96B)
val Warn = Color(0xFFFF6F00)
val SubText = Color(0xFF8A8F98)

private val LightColors = lightColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    secondary = Good,
    background = Color(0xFFF4F6FA),
    surface = Color.White,
    onSurface = Color(0xFF1B1F24),
    surfaceVariant = Color(0xFFEDF0F6),
    onSurfaceVariant = Color(0xFF5A616B)
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF8197FF),
    onPrimary = Color(0xFF0B1020),
    secondary = Good,
    background = Color(0xFF0F1420),
    surface = Color(0xFF171D2A),
    onSurface = Color(0xFFE7EAF0),
    surfaceVariant = Color(0xFF222A3A),
    onSurfaceVariant = Color(0xFFA9B2C2)
)

@Composable
fun PrismRouterTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content
    )
}
