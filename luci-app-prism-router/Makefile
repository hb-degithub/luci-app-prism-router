# SPDX-License-Identifier: Apache-2.0
#
# luci-app-prism-router —— 棱镜路由的 LuCI 前端 + rpcd 后端
#
# 包内只有纯脚本与静态资源（htdocs/ + root/），因此 PKGARCH:=all：
#   htdocs/luci-static/resources/view/prism-router/*.js  → /www/luci-static/resources/view/prism-router/
#   root/usr/share/luci/menu.d/*.json                     → /usr/share/luci/menu.d/
#   root/usr/share/rpcd/acl.d/*.json                      → /usr/share/rpcd/acl.d/
#   root/usr/share/rpcd/ucode/prism-router.uc            → /usr/share/rpcd/ucode/
#
# 安装落点由 luci.mk 统一处理，不需要手写 Package/*/install。
#
# 关于路径：本仓库把包放在 <buildroot>/package/luci-app-prism-router/ 下构建，
# 所以 include 的是 feeds 里的 luci.mk。若把本目录挪进 luci feed 的
# applications/ 下，把最后一行改成 `include ../../luci.mk` 即可。
#
# 守护进程 prism-routerd（ucode + init.d + UCI 默认配置，源码在仓库的
# prism-router/files/）按上游惯例打成**独立包** prism-router，避免把架构相关/
# 常驻组件塞进 luci-app 包（luci.mk 会因此把 PKGARCH 从 all 变成架构相关）。
# 本包通过 LUCI_DEPENDS 依赖它，安装顺序由 opkg 保证。
#
# 安全模块的节点/站点认证共享库 prism-router-node-auth.uc 位于
# prism-router/files/，由 prism-router 包安装到
# /usr/share/prism-router/prism-router-node-auth.uc（存在才装）。
# 若以后有 rpcd ucode 插件放到本包 root/usr/share/rpcd/ucode/ 下，luci.mk 会
# 对 root/ 整棵树递归安装，存在即进包；不要手写 Package/*/install 覆盖通用规则。
# tools/build-ipk.sh 的手工打包路径对以上两种情况都做了条件拷贝。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-prism-router
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=

LUCI_TITLE:=LuCI 棱镜路由（代理/直连 · 设备 · 域名 · 飞书报表）
LUCI_DESCRIPTION:=按设备/域名统计代理与直连流量，含实时速率、记账健康度与飞书日报。数据由 prism-routerd 采集，本包只提供页面与 rpcd 查询接口。
LUCI_PKGARCH:=all

# rpcd-mod-ucode：/usr/share/rpcd/ucode/*.uc 插件（ubus 对象 prism-router）
# ucode-mod-fs / ucode-mod-uci：插件读文件与 UCI
# 概览/详细面板使用内置 SVG（overview.js / panel.js 的 tsRenderLine）；
# 源码已无 L.resource('nlbw.chart.min.js') / window.Chart，故不依赖 luci-lib-chartjs。
# curl + openssl-util：飞书 webhook 与 HMAC-SHA256 签名（rpcd 插件实际 exec 这两个二进制）
# prism-router：数据来源，必须先装
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode +ucode-mod-fs +ucode-mod-uci \
	+curl +openssl-util +prism-router

LUCI_URL:=https://github.com/openwrt/luci

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
