# OpenWrt ipk 格式（2026-11-15 实测纠正）

## 结论
**近几代 OpenWrt（23.05.5 与 24.10 均实测）的 `.ipk` 不是 ar 归档，而是外层 tar.gz。**

实测官方包 `libucode20230711_..._x86_64.ipk` 文件头为 `1f 8b`（gzip），
`tar -tzf` 显示内部结构：

```
./debian-binary      # 内容 "2.0\n"
./data.tar.gz
./control.tar.gz
```

用 ar 封装的包会被 iStoreOS（24.10 系）、官方 24.10 容器、官方 23.05 容器**全部拒绝**，
报错 `pkg_init_from_file: Malformed package file`。

实测对照：下载 `releases/23.05.5/packages/x86_64/base/libucode20230711_*.ipk`，
文件头同样是 `1f 8b`（gzip），内部同为 `./debian-binary + ./data.tar.gz + ./control.tar.gz`。

## 构建要求
- 外层：`tar --owner=0 --group=0 --numeric-owner -czf out.ipk ./debian-binary ./data.tar.gz ./control.tar.gz`
- `data.tar.gz` 内**不得**出现非 root 属主或 700 权限的目录条目（见 INCIDENT-2026-11-14）
- 兼容极旧版本（21.02 及更早，**未验证**）：额外产出 ar 格式一份（`*.legacy.ipk`），默认不要用

## 已验证
`tests/container-validate.sh` 在 `openwrt-24.10:deps` 镜像中：28/28 通过。
`tests/container-validate-2305.sh` 在 `openwrt-23.05:deps` 镜像中：28/28 通过。
