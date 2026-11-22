# 由容器门禁 wrapper 通过 -e 传入；单独运行 inner 时退回源码默认版本。
PRISM_VER="${PRISM_VER:-1.0.32}"
PRISM_ARCH="${PRISM_ARCH:-x86_64}"
PRISM_IPK_NAME="${PRISM_IPK_NAME:-luci-app-prism-router_${PRISM_VER}-1_${PRISM_ARCH}.ipk}"
PRISM_IPK="/src/dist/$PRISM_IPK_NAME"
[ -f "$PRISM_IPK" ] || { echo "FAIL: 缺少 $PRISM_IPK" >&2; exit 1; }

# opkg 安装助手（严格依赖 + 仅为离线镜像缺失的 python3-* 登记“已安装”桩，见该文件说明）
. /src/tests/lib/opkg-install-inner.sh
