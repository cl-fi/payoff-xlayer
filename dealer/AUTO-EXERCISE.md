# 自动行权（Automatic exercise）

状态：已实现于 dealer，默认关闭且 dry-run。操作说明见 `SETTLEMENT.md` 的 "Automatic exercise" 一节。
日期：2026-09-25。

## 0. 结论

- **只用 Hyperliquid。** 价格来自 `xyz:NVDA` 永续的 `oraclePx`（免费、无 key、7×24）。
  ThetaData 不参与判定。
- **规则。** 用链上 `convertToAssets(1e18)` 把 `wrappedQuantity` 折成股数，
  Put 行权条件 `strikeAmountUSDG − 股数×S > 0`，Call 行权条件 `股数×S − strikeAmountUSDG > 0`
  （可选 `minEdgeBps` 阈值，默认 0）。已收的权利金是沉没成本，不进入判定。
- **时机。** 窗口结束前 5 分钟开始判定，每 10 秒重新判定，结束前 60 秒停止发新交易；
  按内在价值从大到小逐个行权。
- **架构。** 跑在 self-dealer 进程内，复用 CLI 的交易 journal 和 PID 锁，
  人工命令和自动行权永远不会同时签名。
- **上线。** 先 `enabled: true, dryRun: true` 观察若干个窗口，再把 `dryRun` 改为 `false`。

## 1. 价格源：Hyperliquid xyz:NVDA 永续

实测（2026-09-25，盘前）：

| 字段 | 值 |
| --- | --- |
| dex / 资产 | `xyz` / `xyz:NVDA`（其它 4 个 dex 的 NVDA 已下架） |
| oraclePx / markPx / midPx | 226.26 / 226.36 / 226.375 |
| mid 相对 oracle 溢价 | ≈ 5 bps |
| 盘口价差 | ≈ 1 bp |
| 未平仓 | 608k 股 ≈ 1.37 亿美元 |
| 24h 成交 | ≈ 4300 万美元 |
| 交易时段 | 7×24 |

接口：`POST https://api.hyperliquid.xyz/info`，body `{"type":"metaAndAssetCtxs","dex":"xyz"}`，
在 `universe` 里按下标找 `xyz:NVDA` 的 ctx。限速每 IP 每分钟 1200 权重，该请求权重 20，
每 10 秒轮询 = 120/分钟。

取 `oraclePx` 而不是 `midPx`/`markPx`：trade.xyz 文档说明美股开盘时 oracle 等于外部数据源推导的公允价，
收盘后退化为按盘口冲击价推进的 30 分钟 EWMA；mid/mark 带永续溢价。
行权窗口 15:30–16:00 ET 在开盘时段内，所以 oracle 就是现货参考价。

与 ThetaData 标的中间价的一致性（前一交易日 9/24 同一时段，逐分钟，41 个点）：
平均差 +0.065 美元（≈ 3 bps），标准差 0.14，最大 0.61（急涨那一分钟）。
这是 1 分钟 K 线收盘价对比，不是 `oraclePx`。

已知限制：ctx 里的 `oraclePx` 没有时间戳，relayer 卡住时看起来仍"新鲜"。
因此用两个代理指标跳过可疑轮询：`|oracle − mid| / oracle` 超过 100 bps，
或连续 6 次轮询 oracle 完全不变；盘口为空或请求失败也跳过。跳过只影响本次轮询，下一次重新判定。

## 2. 判定规则

对每个 dealer 为 `longHolder` 且 `state == Open` 的仓位，每次轮询：

```
rate      = wrappedStock.convertToAssets(1e18)       // 决策时读链上，rate 会漂移
notional  = wrappedQuantity × rate × oracleMicros / 1e36  // USDG 微单位，一次算完避免两次截断
Put  (side 0): intrinsic = strikeAmountUSDG − notional
Call (side 1): intrinsic = notional − strikeAmountUSDG
edgeBps   = intrinsic × 10000 / notional
行权 ⇔ intrinsic > 0 且 edgeBps ≥ minEdgeBps
```

`strikeAmountUSDG` 在开仓时固定，只有股数折算随 rate 变。`minEdgeBps` 默认 0，
即"有优势就行权"；X Layer 出块 1 秒、gas 可忽略。若主网代币化 NVDA 相对真实 NVDA 有基差，
或想覆盖处理收到那条腿的成本，把阈值调成正数即可。

## 3. 时机

窗口 `[exerciseStart, exerciseEnd)` 来自链上 terms，runner 不自己换算时区。

```
end − 5 min − 60 s   开始采样（为"oracle 不变"守卫积累历史）
end − 5 min          开始判定，每 10 s 一次；满足条件的仓位按 edge 从大到小逐个行权
end − 60 s           提交截止：不再发新交易；已发的继续 reconcile
end                  未行权仓位过期
```

每笔行权一个 nonce、等 2 个确认，实测每笔约 3–8 秒，4 分钟能处理三五十个仓位。
仓位更多时调大 `decideBeforeEndSeconds`，或第二阶段给 Vault 加 `exerciseMany(uint256[])`。

未决交易处理：`execute` 返回 `pending` / `broadcast_uncertain` 时循环 `reconcile` 直到最终态，
期间不发新交易；`PREVIOUS_TRANSACTION_UNRESOLVED` 或 `nonce_consumed_needs_review` 则终止本窗口并告警。
操作员 CLI 正持有锁（`TRANSACTION_LOCKED`）时本轮跳过，下一轮重试。

## 4. 架构

- `dealer/src/hyperliquid.mjs`：取价、精确的十进制→微单位转换、守卫。
- `dealer/src/auto-exercise.mjs`：`evaluate`（纯函数）、`windowsOf`（按窗口分组）、
  `AutoExercise`（守护循环 + 窗口执行 + journal）。
- `dealer/src/main.mjs`：在 self-dealer 进程内启动，`autoExercise.enabled=false` 时不做任何事。
- `dealer/src/settlement-cli.mjs evaluate`：只读预览当前 oracle 价和每个仓位的判定。
- `GET /settlement` 返回 `autoExercise: { enabled, dryRun, phase, next, last, lastError }`。
- journal：`DEALER_AUTO_EXERCISE_PATH`（VPS 上 `/var/lib/payoff-dealer/auto-exercise.json`），
  保存最近 30 个窗口的决策、价格、哈希和跳过原因。

为什么进程内而不是独立服务：`ManualSettlement` 的锁用 `process.kill(pid, 0)` 判断持有者是否存活，
只在同一个 PID 命名空间内有效。CLI 通过 `docker compose exec self-dealer` 运行在同一容器里，
所以 runner 也必须在这个容器里，否则会误判锁已失效而并发签名。

## 5. 配置

```json
"autoExercise": {
  "enabled": false,
  "dryRun": true,
  "coins": { "NVDA": "xyz:NVDA" },
  "hyperliquidUrl": "https://api.hyperliquid.xyz/info",
  "hyperliquidDex": "xyz",
  "priceTimeoutMs": 5000,
  "pollMs": 10000,
  "oracleMidBandBps": 100,
  "oracleUnchangedPolls": 6,
  "minEdgeBps": 0,
  "decideBeforeEndSeconds": 300,
  "submitCutoffSeconds": 60,
  "idlePollMs": 300000,
  "skipDates": []
}
```

省略整个块等于关闭。`enabled=false` 是总开关；`dryRun=true` 只记录不签名。
`enabled=true` 时每个 market 的 `symbol` 必须在 `coins` 里有映射。

## 6. 告警与兜底

- 现有 `EXERCISE_WINDOW_APPROACHING`（T−24h）继续提醒检查余额与授权；
  余额或授权不足时 `execute` 会 `blocked`，runner 记录 `AUTO_EXERCISE_BLOCKED` 并跳过该仓位。
- 新告警：`AUTO_EXERCISE_BLOCKED`、`AUTO_EXERCISE_HALTED`、`AUTO_EXERCISE_REVERTED`、
  `MARKET_CLOSED_IN_WINDOW`、`NO_PRICE_SOURCE`、`PRICE_UNAVAILABLE`、`AUTO_EXERCISE_CYCLE_FAILED`。
- runner 不可用时仓位会过期，所以手动 CLI 和监控告警全部保留。

## 7. 系列生成层面的风险

- 半日市（11/27、12/24 等）13:00 ET 收盘，15:30–16:00 的窗口落在收盘后，oracle 退化成 EWMA。
  生成系列时避开这些日期；runner 用 `skipDates` 兜底拒绝判定，周六日直接拒绝。
- 当前窗口是 15:30–16:00 EDT；11 月 1 日夏令时结束后若按固定 UTC 生成，会变成 14:30–15:00 ET。
  生成时必须按 `America/New_York` 计算。

## 8. 上线步骤

1. 单元测试：`npm test --workspace @payoff/self-dealer`。
2. VPS 配置加 `autoExercise: { enabled: true, dryRun: true, coins: { NVDA: "xyz:NVDA" } }`，重建 self-dealer。
3. 用 `settlement-cli.mjs evaluate` 和 `GET /settlement` 核对判定；观察至少 2–3 个行权日的
   `auto_exercise_window` 日志。
4. 改 `dryRun: false`，重建；首周保留人工值守。

## 9. 备选价格源（未采用）

- ThetaData 期权 Greeks 接口的 `underlying_price`：现有期权订阅可用、带时间戳，
  免费股票档位也能拿到实时标的价。已验证但按产品决定不接入。
- Pyth NVDA/USD：Hermes 自 2026-08-26 起需要 API key。
- ThetaData 股票 Standard 档位：不必要。
