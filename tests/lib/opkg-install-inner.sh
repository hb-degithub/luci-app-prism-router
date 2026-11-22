#!/bin/sh
# 容器门禁共用的 opkg 安装助手（由 prism-version-inner.sh 自动 source，也可单独 .）。
#
# 背景：本插件从 1.0.23 起把官方 lark-oapi 及其运行时依赖（pycryptodome 的 musl .so
# 等，Architecture: x86_64）随包分发，因此 Depends 里新增了一组 python3-* 运行时包。
# 门禁镜像（openwrt-24.10:deps / 23.05:deps）带的是**离线 opkg 索引**：
#   * 能按名字判断一个包在 24.10 / 23.05 官方源里是否存在（这正是最容易写错的点，
#     例如 python3-ssl / python3-datetime / python3-netclient 在 24.10 **不存在**）；
#   * 但没有 python3-*.ipk 的实体，`--network none` 下 opkg 无法下载安装。
#
# 做法（只针对 python3-* 一项，且不是 --force-depends）：
#   1) 按 ipk 的 Depends 逐项校验：
#        - 已安装                       -> 通过（与以前完全一致）；
#        - python3-* 且在索引里存在      -> 在 /usr/lib/opkg/status 里登记一个
#          “install user installed” 桩（只写控制字段 + 空 .list），模拟设备上
#          `opkg install python3-light ...` 已完成的状态；
#        - 其它未安装 / python3-* 不在索引 -> 立即失败（包名写错、漏依赖都逃不掉）。
#   2) 然后照常 `opkg install`（**不**加 --force-depends）：依赖检查仍然严格，
#      只是 python3-* 由桩满足，因此 opkg 不会去下载镜像里没有的 .ipk。
#
# 非 python3 依赖仍然必须由镜像预装，否则报错；安装/解包/权限/卸载等所有
# 真实验证项都不受影响。容器是一次性的，桩不会外泄。

prism_ipk_depends() { # $1=ipk -> 打印 Depends 行（逗号分隔）
	local tmp ctl
	tmp=$(mktemp -d 2>/dev/null) || return 0
	# ipk 里的成员名是 ./control.tar.gz：整个解开再取，避免 busybox tar 的成员名匹配差异。
	if ! tar -xzf "$1" -C "$tmp" >/dev/null 2>&1; then
		rm -rf "$tmp"
		return 0
	fi
	ctl=$(tar -xzf "$tmp/control.tar.gz" -O ./control 2>/dev/null \
		| sed -n 's/^Depends:[[:space:]]*//p' | head -1)
	rm -rf "$tmp"
	printf '%s' "$ctl"
}

prism_stub_python_deps() { # $1=ipk；全部满足（含桩）返回 0
	local deps dep ver failed=0
	deps=$(prism_ipk_depends "$1")
	[ -n "$deps" ] || return 0
	mkdir -p /usr/lib/opkg/info
	for dep in $(printf '%s' "$deps" | tr ',' ' '); do
		# 注意：busybox 的 tr 不认 [:space:] 类（会把类里的字符当字面量删掉），用 sed。
		dep=$(printf '%s' "$dep" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
		[ -n "$dep" ] || continue
		if opkg list-installed 2>/dev/null | awk '{print $1}' | grep -qx "$dep"; then
			continue
		fi
		case "$dep" in
			python3-*)
				ver=$(opkg list "$dep" 2>/dev/null | head -1 | awk '{print $3}')
				if [ -n "$ver" ]; then
					echo "  NOTE  $dep 未安装：按目标 release 索引 $ver 登记为“已安装”桩（离线镜像无 .ipk）"
					: > "/usr/lib/opkg/info/$dep.list"
					printf 'Package: %s\nVersion: %s\nArchitecture: all\nStatus: install ok installed\nInstalled-Time: 0\n' \
						"$dep" "$ver" > "/usr/lib/opkg/info/$dep.control"
					printf 'Package: %s\nVersion: %s\nArchitecture: all\nStatus: install ok installed\nInstalled-Time: 0\n\n' \
						"$dep" "$ver" >> /usr/lib/opkg/status
				else
					echo "  FAIL  依赖 $dep 不在 opkg 索引里（包名写错或该 release 不存在）" >&2
					failed=1
				fi
				;;
			*)
				echo "  FAIL  依赖 $dep 未安装，且不是 python3 运行时依赖" >&2
				failed=1
				;;
		esac
	done
	return $failed
}

opkg_install_ipk() { # 参数与 opkg install 相同，ipk 放最后
	local ipk="" arg
	for arg in "$@"; do ipk="$arg"; done
	prism_stub_python_deps "$ipk" || return 1
	opkg install "$@"
}
