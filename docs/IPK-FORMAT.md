# OpenWrt ipk 格式（2026-11-15 实测纠正）

## 结论
**OpenWrt 24.10 及以后的 `.ipk` 不是 ar 归档，而是外层 tar.gz。**

实测官方包 `libucode20230711_..._x86_64.ipk` 文件头为 `1f 8b`（gzip），
`tar -tzf` 显示内部结构：

```
./debian-binary      # 内容 "2.0\n"
./data.tar.gz
./control.tar.gz
```

用 ar 封装的包会同时被 iStoreOS（24.10 系）和官方 24.10 容器拒绝，
报错 `pkg_init_from_file: Malformed package file`。

## 构建要求
- 外层：`tar --owner=0 --group=0 --numeric-owner -czf out.ipk ./debian-binary ./data.tar.gz ./control.tar.gz`
- `data.tar.gz` 内**不得**出现非 root 属主或 700 权限的目录条目（见 INCIDENT-2026-11-14）
- 兼容 ≤23.05：额外产出 ar 格式一份（`*.legacy.ipk`）

## 已验证
`tests/container-validate.sh` 在 `openwrt-24.10:deps` 镜像中：28/28 通过。
