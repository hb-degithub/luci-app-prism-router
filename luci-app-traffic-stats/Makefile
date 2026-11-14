# SPDX-License-Identifier: Apache-2.0
#
# luci-app-traffic-stats —— 流量统计的 LuCI 前端 + rpcd 后端
#
# 包内只有纯脚本与静态资源（htdocs/ + root/），因此 PKGARCH:=all：
#   htdocs/luci-static/resources/view/traffic-stats/*.js  → /www/luci-static/resources/view/traffic-stats/
#   root/usr/share/luci/menu.d/*.json                     → /usr/share/luci/menu.d/
#   root/usr/share/rpcd/acl.d/*.json                      → /usr/share/rpcd/acl.d/
#   root/usr/share/rpcd/ucode/traffic-stats.uc            → /usr/share/rpcd/ucode/
#
# 安装落点由 luci.mk 统一处理，不需要手写 Package/*/install。
#
# 关于路径：本仓库把包放在 <buildroot>/package/luci-app-traffic-stats/ 下构建，
# 所以 include 的是 feeds 里的 luci.mk。若把本目录挪进 luci feed 的
# applications/ 下，把最后一行改成 `include ../../luci.mk` 即可。
#
# 守护进程 traffic-statsd（ucode + init.d + UCI 默认配置，源码在仓库的
# traffic-stats/files/）按上游惯例应打成**独立包**，避免把架构相关/常驻组件
# 塞进 luci-app 包（luci.mk 会因此把 PKGARCH 从 all 变成架构相关）。
# 等 traffic-statsd 包进树以后，把下面 LUCI_DEPENDS 里的注释项打开：
#   LUCI_DEPENDS += +traffic-statsd

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-traffic-stats
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=

LUCI_TITLE:=LuCI 流量统计（代理/直连 · 设备 · 域名 · 飞书报表）
LUCI_DESCRIPTION:=按设备/域名统计代理与直连流量，含实时速率、记账健康度与飞书日报。数据由 traffic-statsd 采集，本包只提供页面与 rpcd 查询接口。
LUCI_PKGARCH:=all

# rpcd-mod-ucode：/usr/share/rpcd/ucode/*.uc 插件（ubus 对象 traffic-stats）
# ucode-mod-fs / ucode-mod-uci：插件读文件与 UCI
# luci-lib-chartjs：概览页环形图（L.resource('nlbw.chart.min.js')，Chart.js v1 API）
# curl + openssl-util：飞书 webhook 与 HMAC-SHA256 签名
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode +ucode-mod-fs +ucode-mod-uci \
	+luci-lib-chartjs +curl +openssl-util

LUCI_URL:=https://github.com/openwrt/luci

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
