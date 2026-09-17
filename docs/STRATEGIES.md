# Strategy reference: version 3.0.0

StockPilot evaluates 11 named setup families and a [42-pattern candle catalogue](CANDLE_PATTERNS.md). This is a finite, documented collection of deterministic rules. It is not every strategy in trading literature, a trained model, or evidence of profitable returns. The [analytics guide](LOGIC_AND_ANALYTICS.md) explains execution, account risk, recovery and historical research.

## Direction and selection

Enhanced intraday analysis evaluates BUY and SELL independently when `intraday_short_enabled` is enabled, then selects the highest-scoring passing setup. BUY establishes a long; SELL establishes a short that must later be bought back. Swing evaluates BUY only, using breakout, trend pullback and range reversion. The original baseline breakout remains available for comparison and is long only.

The tables below describe BUY geometry. For an intraday SELL, reverse the price comparisons and high/low extremes, swap +DI and −DI, negate MACD/histogram/extension, and use `100 - RSI` as directional RSI. Supporting patterns are bearish; opposing patterns are bullish. Thus a short opening-range trade breaks the range low, a short gap continuation holds a gap down, and short relative strength means benchmark underperformance. Prices, fees and quantity remain positive real values. Side is recorded explicitly in signals, fills and journals.

Let `d = +1` for BUY and `-1` for SELL, `C` be the completed signal close, and `R` initial price risk. The standard levels are:

```text
stop = C - d × R
target = C + d × 2R          intraday, except explicit mean/gap targets
target = C + 2.5R           long swing, except the mean target
```

Every passing setup must also pass the configured minimum score. The highest score wins within a side, with setup name as a deterministic tie breaker; a tie between sides uses the side name. The live execution queue then ranks candidates across available symbols. No pattern or score bypasses ownership, price freshness, execution, calendar or account-risk checks.

All new swing entries, including baseline, must pass the shared daily-management policy before buying: completed daily history must be usable, its SMA trend-exit condition must be false, and the proposed entry must be above its daily trailing level. The check runs at signal generation and again at the executable entry/opening price. Thus an apparent range-reversion setup is rejected if the current daily policy already requires liquidating it. This is a fixed consistency gate, not an optional setting; disabling enhanced technical exits does not disable daily swing management.

## Defaults

| Setting | Default | Interpretation |
|---|---|---|
| `enhanced_signals` | `true` | Enables this catalogue; false selects the original baseline. |
| All 11 family flags | `true` | Individual names appear in the coverage table below. |
| `intraday_short_enabled` | `true` | Permits enhanced intraday short candidates; no swing shorts. |
| `candlestick_patterns_enabled` | `true` | Enables contextual pattern confirmation, opposition and score contributions. |
| `technical_exit_enabled` | `true` | Additional completed-candle exits when enhanced mode is enabled. |
| `min_signal_score` | `60` | Minimum heuristic score on a 0–100 scale. |
| `min_adx` | `18` | Trend/range divider for the original three families. |
| `min_rsi`, `max_rsi` | `45`, `78` | Directional RSI band for trend confirmations. |
| `max_atr_extension` | `2.5` | Maximum directional distance from EMA21 in Wilder ATR units. |
| `higher_timeframe_filter` | `true` | Completed 15-minute EMA3/EMA9 alignment for intraday trend families. |
| `opening_range_minutes` | `15` | First three five-minute bars by default. |
| `min_setup_volume` | `1.2` | Relative-volume floor for the eight newer families; squeeze uses at least 1.5. |
| `min_gap_pct`, `max_gap_pct` | `0.005`, `0.05` | Opening-gap magnitude from 0.5% through 5%. |
| `relative_strength_min` | `0.002` | At least 0.2 percentage points of directional excess session return. |
| `squeeze_width_max` | `0.02` | Maximum prior Bollinger width, a fraction of the middle band. |
| `squeeze_lookback` | `20` | Prior width observations used for the lower-quartile threshold. |

## Causal context and warmup

The strategy entry points are `intraday_signal(bars, options, context)` and `swing_signal(bars, options, context)`. They return the selected signal, an overall reason, and enhanced per-family explanations. Live analysis and historical research call these same functions.

For intraday, `bars` contains only today's completed candles. Optional context contains `previous_bars`, `benchmark_bars`, `sector_bars`, and `as_of`, the decision time. Live and research callers supply `as_of`; the strategy rejects an unfinished candle or an intraday candle whose close is at least five minutes old. Daily candles close at 15:30 IST and must not be more than seven days old at evaluation. Naive exchange timestamps are interpreted in IST, independently of the host timezone.

All supplied candles require finite positive OHLC, nonnegative volume, valid geometry, and strictly increasing timestamps. Intraday bars must be consecutive five-minute buckets during 09:15–15:30, within a single current session. Daily dates cannot duplicate or have a gap longer than seven calendar days; enhanced swing also rejects open-to-prior-close discontinuities above 20%.

Prior bars are validated separately per session, must precede the current session, and must end within seven calendar days of it. Up to 150 seed bars advance recursive indicators before the current bars. A final prior-session 15:25 candle is required to establish the previous session close for gap rules. Missing seed does not invent a prior close or a neutral indicator.

EMA/RSI/MACD/ADX use this combined history. The first MACD signal histogram needs 34 combined bars. Each family additionally needs the number of current-session bars listed below. Enhanced swing always needs at least 55 daily bars. A flat or invalid series cannot qualify merely because its length is sufficient.

**VWAP resets daily.** It is the volume-weighted typical price `(high + low + close) / 3` using only current-session candles. Every enhanced intraday family requires uninterrupted coverage beginning at 09:15. A partial `window_vwap` may be shown, but cannot qualify an entry. `previous_bar_vwap` ends at the preceding completed candle of today; it is not yesterday's VWAP.

**Fifteen-minute alignment** uses exactly three consecutive five-minute bars per bucket, anchored at 09:15. It never merges across dates or includes a partial bucket. OHLC is first open, maximum high, minimum low and last close; volume is summed. At least nine complete 15-minute candles are needed for EMA3/EMA9, with prior-session buckets allowed as seed. The latest complete bucket must end less than 15 minutes before the current decision candle closes. BUY alignment requires its close at/above EMA3 and EMA3 above EMA9; SELL reverses this. Range reversion and gap reversal use reversal conditions instead of this trend gate. Swing does not use a 15-minute filter.

**Benchmark joins** require valid candles matching every current symbol timestamp through the decision candle. Future reference bars are rejected, not silently consulted. The stock and benchmark returns both start from their first matched session open. Missing/unmatched benchmark data disables relative strength; it does not imply zero benchmark return. An optional supplied sector series must also align and support the trade. The live service uses NIFTY 50 and available verified sector-index membership; coverage is described in the main guide.

**Volume comparisons** are explicit: the original three families use latest volume divided by the preceding 20-bar mean. The eight newer families prefer the matching clock-time candle of the supplied prior session, falling back to that 20-bar ratio. Opening drive prefers the mean of its first three volumes divided by the mean of the matching three prior-session volumes. This is a one-session comparison, not a multi-year time-of-day volume model.

## Setup coverage and entry conditions

`ATR` below means Wilder ATR14. Body means directional `(close - open) / (high - low)` for BUY, mirrored for SELL. “Previous” excludes the signal candle. Volume is the applicable ratio described above.

The **trend gate** for breakout and pullback requires EMA9 above EMA21, close above EMA21, ADX at least 18, +DI above −DI, and extension at most 2.5 ATR. Intraday also requires close at/above session VWAP and enabled 15-minute alignment.

The **directional gate** for the newer trend families requires the same EMA, DI, extension, VWAP and 15-minute checks, a positive MACD histogram, and directional RSI from 45 through 78. It has no hard minimum ADX; ADX still contributes to the score. Gap reversal uses its separate recovery rules. These distinctions avoid demanding an established trend for every reversal setup.

| Setup / setting flag | Current bars, intraday | BUY structure and additional gates |
|---|---:|---|
| `breakout` / `enable_breakout` | 21 | Close exceeds the previous 20 highs; volume at least 1.5. Intraday SMA5 > SMA20, body at least 0.6 and close within the upper 20% of its range. Swing SMA20 > SMA50, positive body and close within the upper 25%. Trend gate, positive MACD histogram and RSI 45–78. |
| `trend_pullback` / `enable_pullback` | 2 | Current low touches EMA9 or previous low touches previous EMA9; current close reclaims EMA9 with body at least 0.4. Trend gate; MACD positive and histogram improves; RSI 45–70, capped by configured maximum; volume at least 1. A supporting pattern strength at least 60 or a close above the prior high confirms. |
| `range_reversion` / `enable_reversion` | 2 | ADX below 18. Previous close at/below its lower Bollinger band or current low touches the current lower band. Bullish close returns above the lower band but remains below the middle. Previous RSI at most 40; current RSI rises and stays below 55. Supporting pattern at least 60 or close above the prior high. Middle-band target must offer at least 1.2R. |
| `opening_range` / `enable_opening_range` | range minutes / 5 + 1; default 4 | First completed close through the opening-range high: prior close at/below it and current close above. Signal candle opens before 10:30. Body at least 0.5, volume at least 1.2, directional gate. |
| `opening_drive` / `enable_opening_drive` | Exactly 3 | First three candles all bullish, at least two bodies at least 0.5, and successive closes rise. Net first-open-to-third-close move at least 0.5 ATR; opening volume at least 1.2; directional gate. After the third candle, this window is over. |
| `gap_continuation` / `enable_gap_continuation` | 2 | Verified opening gap up 0.5–5%; signal candle opens before 10:30. Close exceeds session open and prior high; every current low remains above previous-session close, leaving the gap unfilled. Body at least 0.4, volume at least 1.2, directional gate. |
| `gap_reversal` / `enable_gap_reversal` | 2 | Verified opening gap down 0.5–5%; signal candle opens before 10:30. Bullish recovery closes above session open, prior high and VWAP with body at least 0.4. Histogram improves and RSI rises; volume at least 1.2. Previous-session close must offer at least 1.2R. No established-trend or 15-minute gate. |
| `vwap_reclaim` / `enable_vwap_reclaim` | 2 | Previous close at/below previous-bar VWAP, current close above current VWAP and prior high. Body at least 0.4, volume at least 1.2, directional gate. |
| `vwap_rejection` / `enable_vwap_rejection` | 2 | Previous close at/above previous-bar VWAP. Current low retests within 0.1 ATR above current VWAP and closes more than 0.1 ATR above it. Body at least 0.4, volume at least 1.2, directional gate. |
| `volatility_squeeze` / `enable_volatility_squeeze` | 2, plus width warmup | Previous Bollinger width at/below 0.02 and at/below the lower quartile of the previous 20 width observations. Current close exceeds the previous upper band and width expands. Body at least 0.5, volume at least `max(1.5, min_setup_volume)`, directional gate. Default width warmup needs 40 combined bars. |
| `relative_strength` / `enable_relative_strength` | 5 | Aligned excess session return over benchmark at least 0.002; when sector context is supplied, sector excess must also be nonnegative. Close exceeds the previous four highs, body at least 0.4, volume at least 1.2, directional gate. |

Only breakout, pullback and range reversion apply to swing. All other rows are intraday. Time windows refer to candle **open** timestamps; all decisions wait until that candle has closed. A seed and enough history allow the opening drive at 09:30 and the default opening-range breakout at 09:35. They do not override missing indicators, full-session VWAP, higher-timeframe alignment or execution cutoffs.

An opposing contextual pattern with strength at least 80 and at least the strongest supporting strength blocks any entry. Only the strongest support/opposition enters this check and the pattern score. Overlapping pattern names do not create repeated majority votes. Turning patterns off removes their confirmation/score contribution, but a required alternative price confirmation still has to pass.

## Stops and targets by family

These are signal references. Live execution subsequently rounds entry and stop against the trade direction and rejects an executable price outside the stop/target interval.

| Family | BUY risk `R` | Target |
|---|---|---|
| Breakout, pullback, relative strength | Intraday `max(1.5 × ATR, 0.004 × C)`; swing `max(2 × ATR, 0.02 × C)` | Standard 2R intraday / 2.5R swing. |
| Range reversion | `max(C - min(last two lows) + 0.25 × ATR, 0.004 × C)` intraday; 1% price floor swing | Current Bollinger middle; minimum 1.2R reward. |
| Opening range | `max(0.004 × C, C - opening range high + 0.25 × ATR)` | 2R. |
| Opening drive | `max(0.004 × C, C - current low + 0.25 × ATR)` | 2R. |
| Gap continuation / reversal | `max(0.004 × C, C - min(last two lows) + 0.25 × ATR)` | Continuation 2R; reversal previous-session close with at least 1.2R reward. |
| VWAP reclaim / rejection | `max(0.004 × C, C - session VWAP + 0.25 × ATR)` | 2R. |
| Volatility squeeze | `max(0.004 × C, C - previous upper band + 0.25 × ATR)` | 2R. |

For SELL, use the corresponding upper/adverse extremes and distances in the opposite direction. All setups reject initial risk above 2.5% of price intraday or 8% swing. Price levels must remain positive and ordered correctly. These are planned distances; gaps and executable fills can produce a larger loss.

## Heuristic score

Each component below is scaled to `[0, 1]` before multiplication by its weight. Scores are summed, clamped to 0–100 and rounded to one decimal. They are not probabilities, forecast confidence intervals or a ranking validated by returns.

| Component | Breakout | Pullback | Range reversion | New eight families |
|---|---:|---:|---:|---:|
| ADX trend / low-ADX range | 20 | 20 | 20 | 20 |
| Directional separation | 10 | 10 | — | 10 |
| Momentum | 15 | 15 | 20 | 15 |
| Relative volume | 20 | 15 | 15 | 20 |
| Candle body / reversal geometry | 15 | 15 | 20 | 15 |
| Limited extension | 10 | 15 | — | — |
| Reward/risk | — | — | 15 | — |
| Required structure satisfied | — | — | — | 10 |
| Strongest supporting pattern | 10 | 10 | 10 | 10 |

Trend ADX scales by 40. Directional separation is `(supporting DI - opposing DI) / (sum of DI)`. Breakout/new-family momentum is directional histogram divided by `0.1 × ATR`; pullback and gap reversal use histogram improvement instead. Breakout volume scales `(ratio - 1) / 2`; pullback/reversion use `ratio / 1.5`; new families use the selected ratio divided by 2. Candle contribution uses directional body/range; reversion also adds the favorable wick fraction. Extension contribution is `1 - directional extension / configured maximum`.

Range score scales low ADX as `1 - ADX/min_adx`, RSI improvement by 10 points, and reward/risk by 2. Pattern contribution is strongest supporting strength / 100. A rejected setup can have a high diagnostic score: every structural gate must pass before the score can authorize a candidate.

## Shared exits

`technical_exit(bars, position, options, context)` is shared by live/paper monitoring and research. It requires enhanced mode and enabled technical exits, valid indicator history and a fresh completed candle. It ignores a candle that closed at/before the recorded entry time. It supports mirrored intraday shorts; swing remains long only.

For a long, it can request an exit when a range-reversion close reaches the current middle band; or close and EMA9 are below EMA21, histogram is negative and −DI exceeds +DI; or an opposing pattern of strength at least 80 accompanies a break of the prior low, falling histogram and RSI below 60. Reverse these directional conditions for a short. For example, the mirrored pattern exit requires a bullish pattern, a prior-high break, improving raw histogram and raw RSI above 40. Stops, targets, timed exits and account-loss controls remain independent.

`daily_holding_exit(bars, position)` is also shared across live delivery, managed paper swing and daily research. With at least 21 valid daily candles, positive simple-average ATR14, no gap over seven days and no open discontinuity above 20%, it computes:

```text
trailing_stop = floor_to_tick(max(previous trailing stop or initial stop,
                                  highest close of last 20 days - 3 × simple ATR14))
trend_exit = last close < SMA20 AND SMA5 < SMA20
```

The stop ratchets upward only. This helper deliberately uses the legacy **simple** ATR, while enhanced entry rules use Wilder ATR. Live/paper monitoring requires a current executable quote; research applies a new daily level only after its source candle has closed and queues a trend exit for the next observed open. GTT operations exist only in live delivery. A higher local trailing level does not automatically replace the original broker GTT stop.

`swing_entry_gate(bars, signal, executable_entry)` applies that same already-known daily policy before new exposure is created. A trend exit blocks with `daily_trend_exit_active`; entry at/below the daily trail blocks with `daily_trailing_exit_active`; unusable history blocks with `daily_entry_history_unavailable`. A later opening gap can fail this gate even when it remains above the original signal stop. A new trail derived from future candles is never used in an earlier entry decision.

Sources: [strategy.js](../src/strategy.js), [strategy-context.js](../src/strategy-context.js), [indicators.js](../src/indicators.js), [patterns.js](../src/patterns.js), [analytics.js](../src/analytics.js).
