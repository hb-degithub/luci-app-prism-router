# 由容器门禁 wrapper 通过 -e 传入；单独运行 inner 时退回源码默认版本。
PRISM_VER="${PRISM_VER:-1.0.10}"
PRISM_IPK_NAME="${PRISM_IPK_NAME:-luci-app-prism-router_${PRISM_VER}-1_all.ipk}"
PRISM_IPK="/src/dist/$PRISM_IPK_NAME"
[ -f "$PRISM_IPK" ] || { echo "FAIL: 缺少 $PRISM_IPK" >&2; exit 1; }
