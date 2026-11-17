#
# traffic-stats —— OpenWrt 流量统计守护进程
#
# 安装内容（全部是脚本，无需编译）：
#   /usr/bin/traffic-statsd          <- files/traffic-statsd.uc
#   /etc/init.d/traffic-statsd       <- files/traffic-statsd.init
#   /etc/config/traffic-stats        <- files/traffic-stats.config  (conffile)
#   /etc/traffic-stats/daily/        每日汇总落盘目录
#
# 契约：docs/SPEC.md
#
include $(TOPDIR)/rules.mk

PKG_NAME:=traffic-stats
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=traffic-stats

PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/traffic-stats
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Traffic Control
  TITLE:=Traffic statistics daemon (OpenClash API + conntrack)
  # curl：push.uc / feishu.uc 的 HTTP 发送；openssl-util：飞书 HMAC 签名、push 签名、
  # ingest.uc / feishu.uc 的 openssl 验签。两者都是运行时真实 exec 的依赖，不能删。
  # uhttpd：独立面板服务（traffic-panel.init）需要系统自带的 uhttpd（不是 LuCI）。
  DEPENDS:=+ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-uloop +curl +openssl-util +uhttpd
  PKGARCH:=all
endef

define Package/traffic-stats/description
  按设备 / 应用 / 出口链路统计流量：clash /connections 负责被接管的流量，
  /proc/net/nf_conntrack 负责未接管的直连流量（fake-ip 段自动去重，不重复计数）。
  结果原子写入 /tmp/traffic-stats/state.json，供 LuCI 读取。
  飞书日报需要 openssl-util（可选，默认关闭）。
endef

define Package/traffic-stats/conffiles
/etc/config/traffic-stats
endef

define Build/Compile
endef

define Package/traffic-stats/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/traffic-statsd.uc $(1)/usr/bin/traffic-statsd

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/traffic-statsd.init $(1)/etc/init.d/traffic-statsd

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/traffic-stats.config $(1)/etc/config/traffic-stats

	$(INSTALL_DIR) $(1)/etc/traffic-stats/daily

	$(INSTALL_DIR) $(1)/usr/share/traffic-stats
	$(if $(wildcard ./files/feishu.uc),$(INSTALL_DATA) ./files/feishu.uc $(1)/usr/share/traffic-stats/feishu.uc)
	$(if $(wildcard ./files/feishu-test.sh),$(INSTALL_BIN) ./files/feishu-test.sh $(1)/usr/share/traffic-stats/feishu-test.sh)
	# 数据 / 日志保留与清理（用户 cron 调用；只动白名单目录，见 docs/SPEC.md §9）
	$(if $(wildcard ./files/retention.uc),$(INSTALL_DATA) ./files/retention.uc $(1)/usr/share/traffic-stats/retention.uc)
	# 子母多节点：子节点推送脚本
	$(if $(wildcard ./files/push.uc),$(INSTALL_DATA) ./files/push.uc $(1)/usr/share/traffic-stats/push.uc)
	# 子母多节点：母节点接收 CGI（必须可执行）
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(if $(wildcard ./files/ingest.uc),$(INSTALL_BIN) ./files/ingest.uc $(1)/www/cgi-bin/traffic-stats-ingest)
	# 哑桥 AP 无线站点元数据（只报信号/速率，不报字节，避免与主路由双计）
	$(if $(wildcard ./files/stations.uc),$(INSTALL_DATA) ./files/stations.uc $(1)/usr/share/traffic-stats/stations.uc)
	# 安全模块的节点/站点认证共享库（存在才装；ingest/push/stations 里仍保留内嵌副本）
	$(if $(wildcard ./files/traffic-stats-node-auth.uc),$(INSTALL_DATA) ./files/traffic-stats-node-auth.uc $(1)/usr/share/traffic-stats/traffic-stats-node-auth.uc)
	$(if $(wildcard ./files/ingest-stations.uc),$(INSTALL_BIN) ./files/ingest-stations.uc $(1)/www/cgi-bin/traffic-stats-stations)
	# Prometheus 指标导出（只读 CGI；token 认证，未启用/未配 token 一律 403，见 SPEC §10.3）
	$(if $(wildcard ./files/traffic-stats-metrics.uc),$(INSTALL_BIN) ./files/traffic-stats-metrics.uc $(1)/www/cgi-bin/traffic-stats-metrics)

	# 独立面板 HTTP 服务（与 LuCI 解耦的只读面板，默认关闭；见 SPEC「独立面板服务」）
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/traffic-panel.init $(1)/etc/init.d/traffic-panel

	# 面板 CGI（ucode，必须可执行：uhttpd -x /cgi-bin 直接 exec）
	$(INSTALL_DIR) $(1)/www/traffic-panel/cgi-bin
	$(if $(wildcard ./files/panel-api.uc),$(INSTALL_BIN) ./files/panel-api.uc $(1)/www/traffic-panel/cgi-bin/panel-api)

	# 面板静态页面（index.html / app.js / style.css；由前端任务提供，存在才装，不因缺文件失败）
	$(INSTALL_DIR) $(1)/www/traffic-panel
	$(if $(wildcard ./files/panel/*),$(foreach f,$(wildcard ./files/panel/*),$(INSTALL_DATA) $(f) $(1)/www/traffic-panel/$(notdir $(f));))
endef

define Package/traffic-stats/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/traffic-statsd enable
	/etc/init.d/traffic-statsd restart
	# 独立面板默认关闭：只跟随 panel.enabled 决定是否开机自启，绝不强制启动。
	if [ "$$(uci -q get traffic-stats.panel.enabled)" = "1" ]; then
		/etc/init.d/traffic-panel enable >/dev/null 2>&1
	else
		/etc/init.d/traffic-panel disable >/dev/null 2>&1
	fi
}
exit 0
endef

define Package/traffic-stats/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/traffic-panel stop >/dev/null 2>&1
	/etc/init.d/traffic-panel disable >/dev/null 2>&1
	/etc/init.d/traffic-statsd stop
	/etc/init.d/traffic-statsd disable
}
exit 0
endef

$(eval $(call BuildPackage,traffic-stats))
