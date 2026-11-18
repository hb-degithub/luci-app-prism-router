package io.prism.router.data

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class UiState(
    val baseUrl: String = "http://192.168.100.1:8099",
    val token: String = "",
    val intervalSec: Int = 15,
    val state: PanelState? = null,
    val error: String? = null,
    val loading: Boolean = false,
    val updatedAt: Long = 0,
    val rxHistory: List<Long> = emptyList(),
    val txHistory: List<Long> = emptyList()
)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("prism-router", Context.MODE_PRIVATE)
    private val client = PanelClient()
    private var job: Job? = null

    var ui by mutableStateOf(UiState())
        private set

    init {
        ui = ui.copy(
            baseUrl = prefs.getString("baseUrl", ui.baseUrl) ?: ui.baseUrl,
            token = prefs.getString("token", "") ?: "",
            intervalSec = prefs.getInt("interval", 15).coerceIn(5, 300)
        )
    }

    fun start() {
        if (job != null) return
        job = viewModelScope.launch {
            while (isActive) {
                refresh()
                delay(ui.intervalSec * 1000L)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    fun refresh() {
        val base = ui.baseUrl
        val token = ui.token
        ui = ui.copy(loading = true)
        viewModelScope.launch {
            try {
                val state = client.fetchState(base, token)
                val rxHist = (ui.rxHistory + state.totals.rxRate).takeLast(24)
                val txHist = (ui.txHistory + state.totals.txRate).takeLast(24)
                ui = ui.copy(
                    state = state,
                    error = null,
                    loading = false,
                    updatedAt = System.currentTimeMillis(),
                    rxHistory = rxHist,
                    txHistory = txHist
                )
            } catch (e: Exception) {
                ui = ui.copy(loading = false, error = e.message ?: "未知错误")
            }
        }
    }

    fun saveSettings(baseUrl: String, token: String, intervalSec: Int) {
        val clean = baseUrl.trim().trimEnd('/')
        prefs.edit()
            .putString("baseUrl", clean)
            .putString("token", token)
            .putInt("interval", intervalSec.coerceIn(5, 300))
            .apply()
        ui = ui.copy(baseUrl = clean, token = token, intervalSec = intervalSec.coerceIn(5, 300))
        stop()
        start()
    }

    fun testConnection(baseUrl: String, token: String, onResult: (String) -> Unit) {
        viewModelScope.launch {
            val result = try {
                client.testConnection(baseUrl.trim().trimEnd('/'), token)
            } catch (e: Exception) {
                "连接失败：${e.message}"
            }
            onResult(result)
        }
    }

    override fun onCleared() {
        stop()
        super.onCleared()
    }
}
