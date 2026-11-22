#
# luci-app-prism-router —— 棱镜路由 / PRISM Router（单包插件）
#
# 一个 ipk 同时包含：采集守护进程、rpcd 查询接口、LuCI 页面、独立面板服务。
#   /usr/bin/prism-routerd                     <- root/usr/bin/prism-routerd
#   /etc/init.d/prism-routerd                  <- root/etc/init.d/prism-routerd
#   /etc/init.d/prism-router-panel             <- root/etc/init.d/prism-router-panel（默认关闭）
#   /etc/config/prism-router                   <- root/etc/config/prism-router（conffile）
#   /usr/share/prism-router/*.uc               <- root/usr/share/prism-router/
#   /usr/share/prism-router/feishu-ws.py       <- 官方 lark-oapi 长连接服务（默认关闭）
#   /etc/init.d/prism-router-feishu-ws         <- procd 服务（ws_enabled=1 才启动）
#   /usr/lib/prism-router/pylib/*              <- 随包分发的 lark-oapi 运行时（musl x86_64）
#   /www/cgi-bin/prism-router-{ingest,stations,metrics,feishu,control}   上报 / 指标 / 飞书 / 家长控制
#   /www/cgi-bin/prism-router-system                                  只读系统信息（无需登录，新增）
#   /www/cgi-bin/prism-router-admin                                   管理员 API（登录 + token，新增）
#   /www/prism-router-panel/                   <- 独立面板静态页与 API
#   /www/luci-static/resources/view/prism-router/*.js   <- htdocs/
#   /www/luci-static/resources/prism-router/*           <- htdocs/（manifest、图标、类别表）
#   /usr/share/rpcd/ucode/prism-router.uc、acl.d、menu.d
#
# 契约：docs/SPEC.md
#
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-prism-router
PKG_VERSION:=1.0.24
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=prism-router
PKG_CONF_SHA:=$(shell sha256sum $(CURDIR)/root/etc/config/prism-router | cut -d' ' -f1)

LUCI_TITLE:=LuCI 棱镜路由（代理/直连 · 设备 · 域名 · 飞书报表）
LUCI_DESCRIPTION:=单包插件：按设备/域名统计代理与直连流量，含实时速率、记账健康度、拓扑、诊断与飞书日报；另带可选独立面板服务。
# 1.0.23 起随包分发 lark-oapi 的 musl 原生扩展（pycryptodome / websockets /
# charset_normalizer 的 .so 都是 cp311-musllinux_x86_64），所以不能再打包成 all。
LUCI_PKGARCH:=x86_64

# luci-base：页面框架；rpcd-mod-ucode：ubus 对象 prism-router；
# ucode-mod-uloop：守护进程事件循环；curl/openssl-util：飞书与签名；
# uhttpd：独立面板服务（默认关闭）。
# python3-*：飞书长连接服务（feishu-ws.py）的运行时。SDK 本身随包放在
# /usr/lib/prism-router/pylib，这里只声明它所依赖的**标准库**分包：
#   asyncio  -> python3-asyncio（WebSocket 客户端）
#   ssl      -> python3-openssl（wss + requests）
#   ctypes   -> python3-ctypes（pycryptodome 加载 .so）
#   logging  -> python3-logging（lark_oapi.core.log）
#   codecs / decimal / email / urllib / uuid / xml -> requests/urllib3/ws 的间接依赖
# 注意：24.10/23.05 的包名是 python3-openssl；python3-ssl / python3-datetime /
# python3-netclient 在这两个 release **不存在**（datetime/socket 在 python3-light
# 里），写进 Depends 会让 opkg 直接装不上，所以没写。
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode +ucode-mod-fs +ucode-mod-uci \
	+ucode-mod-uloop +curl +openssl-util +uhttpd \
	+python3-light +python3-asyncio +python3-codecs +python3-ctypes \
	+python3-decimal +python3-email +python3-logging +python3-openssl \
	+python3-urllib +python3-uuid +python3-xml

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-prism-router/conffiles
/etc/config/prism-router
endef

define Package/luci-app-prism-router/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./root/usr/bin/prism-routerd $(1)/usr/bin/prism-routerd
	$(SED) "s/^\(const[[:space:]]\+DAEMON_VERSION[[:space:]]*=[[:space:]]*\)'[^']*';/\1'$(PKG_VERSION)';/" $(1)/usr/bin/prism-routerd

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/init.d/prism-routerd $(1)/etc/init.d/prism-routerd
	$(INSTALL_BIN) ./root/etc/init.d/prism-router-panel $(1)/etc/init.d/prism-router-panel

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./root/etc/config/prism-router $(1)/etc/config/prism-router

	$(INSTALL_DIR) $(1)/usr/share/prism-router
	$(INSTALL_DATA) ./root/usr/share/prism-router/*.uc $(1)/usr/share/prism-router/
	$(INSTALL_BIN) ./root/usr/share/prism-router/feishu-test.sh $(1)/usr/share/prism-router/feishu-test.sh
	# 官方 lark-oapi 长连接服务（默认关闭；只有 ws_enabled=1 才由 procd 拉起）
	$(INSTALL_BIN) ./root/usr/share/prism-router/feishu-ws.py $(1)/usr/share/prism-router/feishu-ws.py
	$(INSTALL_BIN) ./root/etc/init.d/prism-router-feishu-ws $(1)/etc/init.d/prism-router-feishu-ws

	# 随包分发的 SDK 运行时：不写系统 site-packages，由 init 脚本用 PYTHONPATH 指过来。
	# 目录 755 / 文件 644（.so 也是 644，动态加载器不要求可执行位）。
	$(INSTALL_DIR) $(1)/usr/lib/prism-router
	$(CP) ./pylib $(1)/usr/lib/prism-router/pylib
	find $(1)/usr/lib/prism-router/pylib -type d -exec chmod 755 {} +
	find $(1)/usr/lib/prism-router/pylib -type f -exec chmod 644 {} +

	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./root/usr/share/rpcd/ucode/prism-router.uc $(1)/usr/share/rpcd/ucode/prism-router.uc
	$(SED) "s/^\(const[[:space:]]\+VERSION[[:space:]]*=[[:space:]]*\)'[^']*';/\1'$(PKG_VERSION)';/" $(1)/usr/share/rpcd/ucode/prism-router.uc
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-prism-router.json $(1)/usr/share/rpcd/acl.d/luci-app-prism-router.json
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-prism-router.json $(1)/usr/share/luci/menu.d/luci-app-prism-router.json

	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-ingest $(1)/www/cgi-bin/prism-router-ingest
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-stations $(1)/www/cgi-bin/prism-router-stations
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-metrics $(1)/www/cgi-bin/prism-router-metrics
	$(SED) "s/^\(const[[:space:]]\+VERSION[[:space:]]*=[[:space:]]*\)'[^']*';/\1'$(PKG_VERSION)';/" $(1)/www/cgi-bin/prism-router-metrics
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-feishu $(1)/www/cgi-bin/prism-router-feishu
	$(SED) "s/^\(const[[:space:]]\+VERSION[[:space:]]*=[[:space:]]*\)'[^']*';/\1'$(PKG_VERSION)';/" $(1)/www/cgi-bin/prism-router-feishu
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-control $(1)/www/cgi-bin/prism-router-control
	# 只读系统信息（无登录）+ 管理员 API（token）；两个都必须 755。
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-system $(1)/www/cgi-bin/prism-router-system
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-admin $(1)/www/cgi-bin/prism-router-admin
	$(INSTALL_DIR) $(1)/www/prism-router-panel/cgi-bin
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-control $(1)/www/prism-router-panel/cgi-bin/prism-router-control
	# 面板服务（8099）也要能访问 system/admin：同一份 CGI 再装一份到面板目录。
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-system $(1)/www/prism-router-panel/cgi-bin/prism-router-system
	$(INSTALL_BIN) ./root/www/cgi-bin/prism-router-admin $(1)/www/prism-router-panel/cgi-bin/prism-router-admin

	$(INSTALL_DATA) ./root/www/prism-router-panel/index.html $(1)/www/prism-router-panel/index.html
	$(INSTALL_DATA) ./root/www/prism-router-panel/app.js $(1)/www/prism-router-panel/app.js
	$(INSTALL_DATA) ./root/www/prism-router-panel/style.css $(1)/www/prism-router-panel/style.css
	$(INSTALL_BIN) ./root/www/prism-router-panel/cgi-bin/panel-api $(1)/www/prism-router-panel/cgi-bin/panel-api

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/prism-router
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/prism-router/*.js $(1)/www/luci-static/resources/view/prism-router/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/prism-router
	$(INSTALL_DATA) ./htdocs/luci-static/resources/prism-router/* $(1)/www/luci-static/resources/prism-router/
endef

define Package/luci-app-prism-router/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	# 仅首次安装且当前仍为包内默认配置时迁移；升级或已有用户配置绝不覆盖。
	if [ -f /etc/config/traffic-stats ] \
		&& ! grep -q '^Package: luci-app-prism-router$$' /usr/lib/opkg/status 2>/dev/null \
		&& { [ ! -e /etc/config/prism-router ] || [ "$$(sha256sum /etc/config/prism-router 2>/dev/null | awk '{print $$1}')" = '$(PKG_CONF_SHA)' ]; }; then
		cp -p /etc/config/traffic-stats /etc/config/prism-router 2>/dev/null
		if ! uci -q get prism-router.panel.enabled >/dev/null 2>&1; then
			uci -q set prism-router.panel=panel
			uci -q set prism-router.panel.enabled='0'
			uci -q set prism-router.panel.port='8099'
			uci -q set prism-router.panel.bind=''
			uci -q set prism-router.panel.token=''
			uci -q commit prism-router
		fi
	fi

	# 升级/重装时 conffile 会保留用户配置，新版本新增的 update 段需要补建（只加空段，不覆盖已有值）。
	if ! uci -q get prism-router.update >/dev/null 2>&1; then
		uci -q set prism-router.update=update
		uci -q set prism-router.update.github_repo=''
		uci -q set prism-router.update.github_token=''
		uci -q set prism-router.update.cache_seconds='600'
		uci -q commit prism-router
	fi
	if ! uci -q get prism-router.feishu.ws_enabled >/dev/null 2>&1; then
		uci -q set prism-router.feishu.ws_enabled='0'
		uci -q commit prism-router
	fi
	if [ -d /etc/traffic-stats ]; then
		mkdir -p /etc/prism-router
		cp -a -n /etc/traffic-stats/. /etc/prism-router/ 2>/dev/null || cp -rn /etc/traffic-stats/. /etc/prism-router/ 2>/dev/null
	fi
	if [ -x /etc/init.d/traffic-statsd ]; then
		/etc/init.d/traffic-statsd stop >/dev/null 2>&1
		/etc/init.d/traffic-statsd disable >/dev/null 2>&1
	fi

	/etc/init.d/prism-routerd enable
	/etc/init.d/prism-routerd restart
	# 独立面板默认关闭：只跟随 panel.enabled 决定是否开机自启，绝不强制启动。
	if [ "$$(uci -q get prism-router.panel.enabled)" = "1" ]; then
		/etc/init.d/prism-router-panel enable >/dev/null 2>&1
	else
		/etc/init.d/prism-router-panel disable >/dev/null 2>&1
	fi
	# 飞书长连接默认关闭：ws_enabled=1 才 enable，否则 disable（升级不改变用户选择）。
	if [ "$$(uci -q get prism-router.feishu.ws_enabled)" = "1" ]; then
		/etc/init.d/prism-router-feishu-ws enable >/dev/null 2>&1
		/etc/init.d/prism-router-feishu-ws restart >/dev/null 2>&1
	else
		/etc/init.d/prism-router-feishu-ws stop >/dev/null 2>&1
		/etc/init.d/prism-router-feishu-ws disable >/dev/null 2>&1
	fi
}
exit 0
endef

define Package/luci-app-prism-router/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/prism-router-feishu-ws stop >/dev/null 2>&1
	/etc/init.d/prism-router-feishu-ws disable >/dev/null 2>&1
	/etc/init.d/prism-router-panel stop >/dev/null 2>&1
	/etc/init.d/prism-router-panel disable >/dev/null 2>&1
	/etc/init.d/prism-routerd stop >/dev/null 2>&1
	/etc/init.d/prism-routerd disable >/dev/null 2>&1
}
exit 0
endef
