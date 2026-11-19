package io.prism.router.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 网络配置的解析、校验与错误码映射（纯 JVM，不访问网络）。
 *
 * 对应后端 `?action=config` 的响应结构，以及保存前的 IP / 掩码 / 端口 / 主机名 /
 * 地址池校验 —— 这些函数决定「本地先拦一道」的判定，必须与后端错误码对齐。
 */
class ConfigClientParseTest {
    private val client = ConfigClient()

    @Test
    fun parsesAllSectionsAndRedirects() {
        val data = client.parseConfig(
            """
            {
              "lan": {
                "ipaddr": "192.168.100.1",
                "netmask": "255.255.255.0",
                "gateway": "192.168.100.1",
                "dns": ["223.5.5.5", "1.1.1.1"]
              },
              "wan": {
                "proto": "static",
                "device": "eth0",
                "ipaddr": "10.0.0.2",
                "netmask": "255.255.255.0",
                "gateway": "10.0.0.1",
                "dns": ["8.8.8.8"]
              },
              "dhcp": {"enabled": true, "start": "100", "limit": "150", "leasetime": "12h"},
              "system": {"hostname": "iStoreOS", "timezone": "CST-8", "zonename": "Asia/Shanghai"},
              "redirects": [
                {
                  "index": 0,
                  "name": "NAS",
                  "src": "lan",
                  "dest": "lan",
                  "src_dport": "8080",
                  "dest_ip": "192.168.100.10",
                  "dest_port": "80",
                  "proto": "tcp",
                  "enabled": true
                },
                {
                  "index": 1,
                  "name": "",
                  "src": "wan",
                  "dest": "lan",
                  "src_dport": "53",
                  "dest_ip": "192.168.100.2",
                  "dest_port": "53",
                  "proto": "udp",
                  "enabled": false
                }
              ]
            }
            """.trimIndent()
        )

        assertEquals("192.168.100.1", data.lan.ipaddr)
        assertEquals(2, data.lan.dns.size)
        assertEquals("223.5.5.5, 1.1.1.1", data.lan.dnsText)

        assertEquals(WanProto.STATIC, data.wan.protoType)
        assertTrue(data.wan.static)
        assertEquals("eth0", data.wan.device)

        assertTrue(data.dhcp.enabled)
        assertEquals("12h", data.dhcp.leasetime)
        assertEquals(249, data.dhcp.poolEnd ?: -1)

        assertEquals("iStoreOS", data.system.hostname)
        assertEquals("Asia/Shanghai", data.system.zonename)

        assertEquals(2, data.redirects.size)
        assertEquals("NAS", data.redirects[0].displayName)
        assertEquals("192.168.100.10:80", data.redirects[0].targetText)
        assertEquals("LAN", data.redirects[0].srcLabel)
        assertEquals("LAN", data.redirects[0].destLabel)
        assertEquals("未命名规则", data.redirects[1].displayName)
        assertFalse(data.redirects[1].enabled)
        assertEquals("UDP", data.redirects[1].protoLabel)
    }

    @Test
    fun missingSectionsFallBackToDefaultsWithoutCrash() {
        val data = client.parseConfig("""{"lan":{"ipaddr":"192.168.1.1"}}""")
        assertEquals("192.168.1.1", data.lan.ipaddr)
        assertEquals("", data.lan.netmask)
        assertTrue(data.lan.dns.isEmpty())
        assertEquals(WanProto.DHCP, data.wan.protoType)
        assertTrue(data.dhcp.enabled)
        assertEquals("", data.system.hostname)
        assertTrue(data.redirects.isEmpty())
    }

    @Test
    fun mapsBackendErrorCodesToChinese() {
        assertEquals("IP 地址格式不正确", ConfigClient.messageFor("invalid_ip"))
        assertEquals("子网掩码不正确（要求连续的点分掩码）", ConfigClient.messageFor("invalid_netmask"))
        assertEquals("主机名不合法（1–63 位字母、数字或 -，首尾不能是 -）", ConfigClient.messageFor("invalid_hostname"))
        assertEquals("端口不合法（1–65535）", ConfigClient.messageFor("invalid_port"))
        assertEquals("登录已过期，请重新登录", ConfigClient.messageFor("unauthorized"))
        assertEquals("路由器正忙，请稍后重试", ConfigClient.messageFor("busy"))
        /* 未知码保留原值，避免把没见过的错误翻错。 */
        assertTrue(ConfigClient.messageFor("weird_error").contains("weird_error"))
    }

    @Test
    fun mapsErrorCodeToField() {
        assertEquals("ipaddr", ConfigClient.fieldFor("invalid_ip"))
        assertEquals("netmask", ConfigClient.fieldFor("invalid_netmask"))
        assertEquals("hostname", ConfigClient.fieldFor("invalid_hostname"))
        assertEquals("dest_port", ConfigClient.fieldFor("invalid_port"))
        /* 分组级错误不定位到具体输入框。 */
        assertEquals("", ConfigClient.fieldFor("internal"))
    }

    @Test
    fun validatesIpv4Strictly() {
        assertTrue(isValidIpv4("192.168.100.1"))
        assertTrue(isValidIpv4("0.0.0.0"))
        assertFalse(isValidIpv4("256.1.1.1"))
        assertFalse(isValidIpv4("192.168.1"))
        assertFalse(isValidIpv4("192.168.01.1")) // 前导零会被路由器按八进制解释
        assertFalse(isValidIpv4(""))
    }

    @Test
    fun validatesNetmaskContinuity() {
        assertTrue(isValidNetmask("255.255.255.0"))
        assertTrue(isValidNetmask("255.255.0.0"))
        assertFalse(isValidNetmask("255.0.255.0"))
        assertFalse(isValidNetmask("0.0.0.0"))
    }

    @Test
    fun validatesHostname() {
        assertTrue(isValidHostname("iStoreOS"))
        assertTrue(isValidHostname("prism-router.lan"))
        assertFalse(isValidHostname("-bad"))
        assertFalse(isValidHostname("bad-"))
        assertFalse(isValidHostname(""))
        assertFalse(isValidHostname("主机名"))
    }

    @Test
    fun parsesPortsAndDns() {
        assertEquals(8080, parsePortNumber("8080") ?: -1)
        assertEquals(1, parsePortNumber(" 1 ") ?: -1)
        assertNull(parsePortNumber("0"))
        assertNull(parsePortNumber("65536"))
        assertNull(parsePortNumber(""))
        assertNull(parsePortNumber("80a"))

        assertEquals(listOf("223.5.5.5", "1.1.1.1"), parseDnsList("223.5.5.5, 1.1.1.1"))
        assertEquals(listOf("1.1.1.1"), parseDnsList("1.1.1.1，1.1.1.1")) // 中文逗号 + 去重
        assertTrue(parseDnsList(" , ; ").isEmpty())
    }

    @Test
    fun validatesDhcpPool() {
        assertNull(dhcpPoolError("100", "150"))
        assertNull(dhcpPoolError("1", "254"))
        /* 起始 + 数量 - 1 = 300 > 254。 */
        assertNotNullMessage(dhcpPoolError("200", "100"))
        assertNotNullMessage(dhcpPoolError("0", "10"))
        assertNotNullMessage(dhcpPoolError("100", "0"))
    }

    @Test
    fun validatesLeasetime() {
        assertTrue(isValidLeasetime("12h"))
        assertTrue(isValidLeasetime("30m"))
        assertTrue(isValidLeasetime("43200"))
        assertTrue(isValidLeasetime("infinite"))
        assertFalse(isValidLeasetime("0"))
        assertFalse(isValidLeasetime(""))
        assertFalse(isValidLeasetime("12x"))
    }

    private fun assertNotNullMessage(value: String?) {
        assertTrue("期望校验失败但返回了 null", value != null)
    }
}
