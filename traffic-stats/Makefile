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
  DEPENDS:=+ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-uloop +curl +openssl-util
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
	$(if $(wildcard ./files/ingest-stations.uc),$(INSTALL_BIN) ./files/ingest-stations.uc $(1)/www/cgi-bin/traffic-stats-stations)
endef

define Package/traffic-stats/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/traffic-statsd enable
	/etc/init.d/traffic-statsd restart
}
exit 0
endef

define Package/traffic-stats/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/traffic-statsd stop
	/etc/init.d/traffic-statsd disable
}
exit 0
endef

$(eval $(call BuildPackage,traffic-stats))
