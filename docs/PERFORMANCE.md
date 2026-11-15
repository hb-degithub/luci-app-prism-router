# 性能实测与优化（2026-11-15）

环境：主路由 iStoreOS 24.10.7 / Intel J4125 4C @2.0GHz / 3.7GB，OpenClash fake-ip，conntrack ≈1400 条。

## 一、一轮采集的时间去向（实测，非估算）

| 环节 | 耗时 |
|---|---|
| 内核 dump `/proc/net/nf_conntrack`（1432 条，288 KB） | **0–12 ms** |
| clash `/connections`（88–90 条连接） | **15–19 ms** |
| 解析 + 聚合 + 构建 state + 落盘 | **≈150 ms** |
| 空 conntrack 的框架底噪 | 12 ms |
| **合计 poll_ms** | **165–211 ms / 5s** |

结论：瓶颈不在内核、不在网络，而在 **ucode 单线程解析 + 聚合**。
同样 1432 条真实数据在开发机容器里只要 17 ms——差距来自 J4125 的单核性能（约 10 倍）。

## 二、已做的优化：自适应轮询

- 连续 2 轮四个方向增量全为 0 → 间隔由 5s 升到 **15s**（`base*3`，上限 30s）
- 任意一轮有流量 → 立即回到 5s
- 速率由 poll 内部按实际 `dt` 计算，降频不影响速率正确性

**确定性验证**（隔离环境、空 conntrack）：

```
traffic-statsd: adaptive interval -> 15s (idle_rounds=2)
45 秒内轮询 4 次（固定 5s 时是 9 次）
```

效果：空闲期 CPU 降到约 1/3；实测活跃期由 5.2% 降到 4.4%。

## 三、评估过但未采用的方案

| 方案 | 不采用的原因 |
|---|---|
| 用 ctnetlink 事件替代全量 dump | 需要 C 实现，工程量大，当前收益不足 |
| 优化 `split()` 为手写扫描 | 解析只占 ~150ms 的一部分，收益不确定 |
| 降低默认间隔到 10s | 牺牲实时性，且不如自适应按需降频 |
| 用 nlbwmon 做设备总量 | 已确认其数据模型无目的地址，无法做 per-app |

## 四、复测方法

```sh
# 真机单轮耗时
TRAFFIC_STATS_ONCE=1 TRAFFIC_STATS_CLASH_API=127.0.0.1:9090 \
  TRAFFIC_STATS_STATE_DIR=/tmp/b ucode /usr/bin/traffic-statsd
ucode -e "let d=json(require('fs').readfile('/tmp/b/state.json')); print(d.health.poll_ms)"
```
