package io.prism.router.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PanelClient 的 JSON 解析测试：直接用真实形态的 JSON 字符串，
 * 不建 OkHttp 连接、不访问网络（[PanelClient] 只在构造时准备客户端）。
 */
class PanelClientParseTest {

    private val client = PanelClient()

    /* ───────────────────────── state ───────────────────────── */

    private val stateJson = """
        {
          "ts": 1732000000,
          "running": true,
          "totals": {
            "rx": 1000, "tx": 2000,
            "rx_rate": 10, "tx_rate": 20,
            "direct_rx": 700, "direct_tx": 800,
            "proxy_rx": 300, "proxy_tx": 400,
            "wifi_rx": 100, "wifi_tx": 200,
            "wired_rx": 900, "wired_tx": 1800,
            "month_total": 3000
          },
          "devices": [
            {
              "hostname": "phone",
              "mac": "aa:bb:cc:dd:ee:ff",
              "ip": "10.0.0.2",
              "link": "wifi",
              "rx_rate": 5, "tx_rate": 7,
              "direct_rx": 100, "direct_tx": 200,
              "proxy_rx": 300, "proxy_tx": 400,
              "month_total": 1000,
              "last_seen": 1732000100,
              "quota_limit": 5000,
              "apps": {
                "example.com": {"rx": 10, "tx": 20, "chain": "DIRECT"},
                "video.example.org": {"rx": 40, "tx": 60, "chain": "MIXED"}
              }
            },
            {
              "ip": "10.0.0.3",
              "link": "unknown",
              "month_total": 500,
              "last_seen": 0
            }
          ],
          "apps": [
            {"host": "a.com", "rx": 5, "tx": 6, "devices": 2, "chain": "DIRECT"},
            {"host": "b.com", "rx": 50, "tx": 60, "devices": 1, "chain": "MIXED"}
          ],
          "nodes": {
            "HK-01": {"rx": 10, "tx": 20},
            "JP-01": {"rx": 1, "tx": 2}
          },
          "health": {
            "accounting_confidence": "ok",
            "reasons": ["r1", "r2"],
            "clash_connections": 7,
            "link_source": "arp",
            "link_bridge": "off",
            "clash_poll_ms": 500
          },
          "source": {"clash": "ok", "conntrack": "ok"},
          "quota": {"device_limit": 50000}
        }
    """.trimIndent()

    @Test
    fun parseState_readsTotals() {
        val s = client.parseState(stateJson)
        assertEquals(1732000000L, s.ts)
        assertTrue(s.running)
        assertEquals(1000L, s.totals.rx)
        assertEquals(2000L, s.totals.tx)
        assertEquals(3000L, s.totals.total)
        assertEquals(10L, s.totals.rxRate)
        assertEquals(20L, s.totals.txRate)
        assertEquals(3000L, s.totals.monthTotal)
        assertEquals(100L, s.totals.wifiRx)
        assertEquals(1800L, s.totals.wiredTx)
    }

    @Test
    fun parseState_readsDevices_sortedByTotal_withNameFallback() {
        val s = client.parseState(stateJson)
        assertEquals(2, s.devices.size)

        val phone = s.devices[0]
        assertEquals("phone", phone.name)
        assertEquals("aa:bb:cc:dd:ee:ff", phone.mac)
        assertEquals("wifi", phone.link)
        assertEquals(1000L, phone.total)
        assertEquals(5000L, phone.quotaLimit)
        assertEquals(1732000100L, phone.lastSeen)

        /* 没有 hostname 时用 ip 兜底；total 0 排在后面。 */
        val other = s.devices[1]
        assertEquals("10.0.0.3", other.name)
        assertEquals("unknown", other.link)
        assertEquals(0L, other.lastSeen)
        assertEquals(0L, other.quotaLimit)
        assertTrue(other.apps.isEmpty())
    }

    @Test
    fun parseState_readsDeviceApps() {
        val apps = client.parseState(stateJson).devices[0].apps
        assertEquals(2, apps.size)

        val direct = apps.getValue("example.com")
        assertEquals(10L, direct.rx)
        assertEquals(20L, direct.tx)
        assertEquals("DIRECT", direct.chain)
        assertTrue(direct.isDirect)
        assertEquals(30L, direct.total)

        val proxy = apps.getValue("video.example.org")
        assertEquals("MIXED", proxy.chain)
        assertFalse(proxy.isDirect)
        assertFalse(proxy.isOther)
        assertEquals("video.example.org", proxy.displayName)
    }

    @Test
    fun parseState_readsApps_sortedByTotal() {
        val apps = client.parseState(stateJson).apps
        assertEquals(2, apps.size)
        assertEquals("b.com", apps[0].host)
        assertEquals(110L, apps[0].total)
        assertEquals(1, apps[0].devices)
        assertEquals("a.com", apps[1].host)
        assertEquals(11L, apps[1].total)
    }

    @Test
    fun parseState_readsNodes_sortedByTotal() {
        val nodes = client.parseState(stateJson).nodes
        assertEquals(2, nodes.size)
        assertEquals("HK-01", nodes[0].name)
        assertEquals(30L, nodes[0].total)
        assertEquals("JP-01", nodes[1].name)
        assertEquals(3L, nodes[1].total)
    }

    @Test
    fun parseState_readsHealthAndSources() {
        val s = client.parseState(stateJson)
        assertEquals("ok", s.health.confidence)
        assertEquals(listOf("r1", "r2"), s.health.reasons)
        assertEquals(7L, s.health.clashConnections)
        assertEquals(500L, s.health.clashPollMs)
        assertEquals("arp", s.health.linkSource)
        assertEquals("off", s.health.linkBridge)
        assertEquals("ok", s.clash)
        assertEquals("ok", s.conntrack)
    }

    @Test
    fun parseState_readsQuota() {
        assertEquals(50000L, client.parseState(stateJson).quotaDeviceLimit)
    }

    @Test
    fun parseState_toleratesEmptyObject() {
        val s = client.parseState("{}")
        assertEquals(0L, s.ts)
        assertFalse(s.running)
        assertEquals(0L, s.totals.total)
        assertTrue(s.devices.isEmpty())
        assertTrue(s.apps.isEmpty())
        assertTrue(s.nodes.isEmpty())
        /* 缺失的健康字段按 unknown；数据源缺失保持空串（= 未知，不误判为故障）。 */
        assertEquals("unknown", s.health.confidence)
        assertTrue(s.health.reasons.isEmpty())
        assertEquals("", s.clash)
        assertEquals("", s.conntrack)
        assertEquals(0L, s.quotaDeviceLimit)
    }

    /* ───────────────────────── history ───────────────────────── */

    @Test
    fun parseHistory_summaryAndBuckets() {
        val json = """
            {
              "days": [
                {
                  "day": "2024-11-19",
                  "buckets": [
                    {"direct_rx": 1, "direct_tx": 2, "proxy_rx": 3, "proxy_tx": 4},
                    {"direct_rx": 10, "direct_tx": 20, "proxy_rx": 30, "proxy_tx": 40}
                  ]
                },
                {
                  "day": "2024-11-18",
                  "summary": {
                    "totals": {
                      "rx": 1000, "tx": 2000,
                      "direct_rx": 300, "direct_tx": 400,
                      "proxy_rx": 700, "proxy_tx": 1600
                    }
                  }
                }
              ]
            }
        """.trimIndent()

        val days = client.parseHistory(json)
        assertEquals(2, days.size)

        /* 结果按日期升序：18 号在前。summary 形态直接用汇总值。 */
        val summary = days[0]
        assertEquals("2024-11-18", summary.day)
        assertEquals("11-18", summary.dayLabel)
        assertEquals(1000L, summary.rx)
        assertEquals(2000L, summary.tx)
        assertEquals(3000L, summary.total)
        assertEquals(300L, summary.directRx)
        assertEquals(400L, summary.directTx)
        assertEquals(700L, summary.proxyRx)
        assertEquals(1600L, summary.proxyTx)

        /* 当日只有 5 分钟桶：四个方向累加，rx/tx 由直连 + 代理合成。 */
        val buckets = days[1]
        assertEquals("2024-11-19", buckets.day)
        assertEquals(11L, buckets.directRx)
        assertEquals(22L, buckets.directTx)
        assertEquals(33L, buckets.proxyRx)
        assertEquals(44L, buckets.proxyTx)
        assertEquals(44L, buckets.rx)
        assertEquals(66L, buckets.tx)
        assertEquals(110L, buckets.total)
    }

    @Test
    fun parseHistory_skipsBlankDay_andMissingDays() {
        assertTrue(client.parseHistory("{}").isEmpty())
        assertTrue(client.parseHistory("""{"days":[]}""").isEmpty())
        assertTrue(client.parseHistory("""{"days":[{"buckets":[]}]}""").isEmpty())
    }

    /* ───────────────────────── nodes ───────────────────────── */

    @Test
    fun parseNodes_readsAgeSec_andFallsBackWhenMissing() {
        val json = """
            {
              "nodes": [
                {
                  "node_id": "n1",
                  "name": "客厅 AP",
                  "ts": 1732000000,
                  "age_sec": 30,
                  "latest": {
                    "totals": {"rx": 10, "tx": 20},
                    "devices": [{"mac": "aa"}, {"mac": "bb"}]
                  }
                },
                {
                  "node_id": "n2",
                  "name": "",
                  "latest": {
                    "totals": {"direct_rx": 1, "direct_tx": 2, "proxy_rx": 3, "proxy_tx": 4}
                  }
                }
              ]
            }
        """.trimIndent()

        val nodes = client.parseNodes(json)
        assertEquals(2, nodes.size)

        /* 在线优先：30 秒 < 300 秒窗口。 */
        val online = nodes[0]
        assertEquals("n1", online.nodeId)
        assertEquals("客厅 AP", online.displayName)
        assertEquals(30L, online.ageSec)
        assertEquals(NodeFreshness.ONLINE, online.freshness)
        assertEquals("在线", online.freshnessText())
        assertEquals(2, online.deviceCount)
        assertEquals(30L, online.total)

        /* age_sec 缺失 → -1（未上报），不是 0 秒；ts 也不参与计算。 */
        val unknown = nodes[1]
        assertEquals("n2", unknown.nodeId)
        assertEquals(-1L, unknown.ageSec)
        assertEquals(NodeFreshness.UNKNOWN, unknown.freshness)
        assertEquals("未上报", unknown.freshnessText())
        assertEquals("n2", unknown.displayName)
        assertEquals(0, unknown.deviceCount)
        /* totals 没有 rx/tx 时退回 direct_* + proxy_*。 */
        assertEquals(4L, unknown.rx)
        assertEquals(6L, unknown.tx)
        assertEquals(10L, unknown.total)
    }

    @Test
    fun parseNodes_toleratesEmptyBody() {
        assertTrue(client.parseNodes("{}").isEmpty())
        assertTrue(client.parseNodes("""{"nodes":[]}""").isEmpty())
    }
}
