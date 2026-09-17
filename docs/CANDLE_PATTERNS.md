# Implemented candle formations

StockPilot recognizes these **42 named formations** in [patterns.js](../src/patterns.js). This is the program's fixed catalogue, not an exhaustive list of names used by traders. Pattern detection does not establish predictive accuracy. The [analytics guide](LOGIC_AND_ANALYTICS.md#4-baseline-and-enhanced-entry-rules) explains how patterns combine with price, momentum, volume and risk checks.

For each candle, `range = high - low`, `body = abs(close - open)`, `upper shadow = high - max(open, close)`, and `lower shadow = min(open, close) - low`. A small body is at most 30% of range, a long body at least 60%, and a doji at most 10%. Zero-range bars do not satisfy directional body/shadow shapes. Invalid prices prevent detection.

The detector examines the latest ten supplied candles and emits formations ending at the latest completed candle. Context uses up to five candles **before** the formation, with at least three required. A close-to-close move greater than half their mean range is an uptrend; less than negative half is a downtrend; otherwise it is a range. Required context must match: a hammer-shaped candle after a rise is not emitted as a bullish hammer. These definitions describe the implemented heuristics and can differ from a book's definitions.

| Formation | Candles | Required context / implemented geometry |
|---|---:|---|
| Doji | 1 | Neutral; body at most 10% of range. |
| Long-legged doji | 1 | Neutral; doji with both shadows at least 35% of range. |
| Spinning top | 1 | Neutral; body above 10% and at most 30%; both shadows at least 25%. |
| High-wave candle | 1 | Neutral; body at most 20%; both shadows at least 35%. |
| Inside bar | 2 | Neutral; current range lies within prior range, with at least one strict boundary. |
| Outside bar | 2 | Neutral; current range strictly exceeds both ends of prior range. |
| Bullish marubozu | 1 | Bullish; body at least 90% of range. |
| Bearish marubozu | 1 | Bearish; body at least 90% of range. |
| Hammer | 1 | Downtrend; non-doji body at most 35%, lower shadow at least twice body, upper shadow at most 10% of range. |
| Hanging man | 1 | Uptrend; the same lower-shadow geometry as hammer. |
| Inverted hammer | 1 | Downtrend; non-doji body at most 35%, upper shadow at least twice body, lower shadow at most 10% of range. |
| Shooting star | 1 | Uptrend; the same upper-shadow geometry as inverted hammer. |
| Dragonfly doji | 1 | Downtrend; doji, lower shadow at least 70%, upper shadow at most 10%. |
| Gravestone doji | 1 | Uptrend; doji, upper shadow at least 70%, lower shadow at most 10%. |
| Bullish engulfing | 2 | Downtrend; bullish body contains prior bearish body and is at least 5% larger. |
| Bearish engulfing | 2 | Uptrend; bearish body contains prior bullish body and is at least 5% larger. |
| Bullish harami | 2 | Downtrend; small bullish body lies strictly inside prior long bearish body. |
| Bearish harami | 2 | Uptrend; small bearish body lies strictly inside prior long bullish body. |
| Bullish harami cross | 2 | Downtrend; doji body lies strictly inside prior long bearish body. |
| Bearish harami cross | 2 | Uptrend; doji body lies strictly inside prior long bullish body. |
| Piercing line | 2 | Downtrend; bullish candle opens below prior long bearish close and closes above its body midpoint but below its open. |
| Dark cloud cover | 2 | Uptrend; bearish candle opens above prior long bullish close and closes below its body midpoint but above its open. |
| Tweezer bottom | 2 | Downtrend; bearish then bullish candles with lows within 5% of their mean range. |
| Tweezer top | 2 | Uptrend; bullish then bearish candles with highs within 5% of their mean range. |
| Morning star | 3 | Downtrend; long bearish body, small body below its close, then bullish close above the first body's midpoint. |
| Evening star | 3 | Uptrend; long bullish body, small body above its close, then bearish close below the first body's midpoint. |
| Morning doji star | 3 | Morning-star conditions with a doji middle candle. |
| Evening doji star | 3 | Evening-star conditions with a doji middle candle. |
| Three white soldiers | 3 | Downtrend; three rising bullish bodies at least 50% of range; each later open inside the preceding body; upper shadows at most 25%. |
| Three black crows | 3 | Uptrend; three falling bearish bodies at least 50% of range; each later open inside the preceding body; lower shadows at most 25%. |
| Three inside up | 3 | Downtrend; bullish harami followed by bullish close above the first candle's open. |
| Three inside down | 3 | Uptrend; bearish harami followed by bearish close below the first candle's open. |
| Three outside up | 3 | Downtrend; bullish engulfing followed by another bullish candle closing higher. |
| Three outside down | 3 | Uptrend; bearish engulfing followed by another bearish candle closing lower. |
| Rising three methods | 5 | Uptrend; long bullish candle, three small candles inside its range (at least one bearish), then a long bullish close above the first close. |
| Falling three methods | 5 | Downtrend; long bearish candle, three small candles inside its range (at least one bullish), then a long bearish close below the first close. |
| Bullish kicker | 2 | Downtrend; long bearish then long bullish candle opening above the prior open. |
| Bearish kicker | 2 | Uptrend; long bullish then long bearish candle opening below the prior open. |
| Bullish belt hold | 1 | Downtrend; bullish body at least 70%, lower shadow at most 5%. |
| Bearish belt hold | 1 | Uptrend; bearish body at least 70%, upper shadow at most 5%. |
| Bullish abandoned baby | 3 | Downtrend; long bearish candle, doji entirely below its low and below the next candle's low, then bullish midpoint recovery. |
| Bearish abandoned baby | 3 | Uptrend; long bullish candle, doji entirely above its high and above the next candle's high, then bearish midpoint reversal. |

Each match records its ID, name, bullish/bearish/neutral direction, candle count, preceding context and a fixed heuristic strength. Overlapping names may appear together, such as morning star and morning doji star. The strategy uses the **strongest** bullish and strongest bearish match; it does not add a vote for every alias. Neutral shapes are descriptive and do not create a directional entry by themselves.

With contextual confirmations enabled, supporting strength of at least 60 can confirm a pullback or range-reversion setup. Opposing strength of at least 80 that is no weaker than the support blocks a new setup. For longs, bullish patterns support entry and bearish patterns oppose it; intraday shorts mirror those roles. A pattern-based long exit also needs a break of the prior low and deteriorating momentum; a short exit mirrors this with a prior-high break and improving momentum. Swing remains long-only. Disabling candle confirmations removes pattern contributions and vetoes; it does not bypass the other setup, data, authorization or account-risk gates. See the [directional strategy reference](STRATEGIES.md).

Strength is not a historical win rate, confidence interval or profit probability. Candle boundaries, discontinuities, corporate actions and incomplete history can change the detected formation. The app uses completed candles and validates continuity before entry decisions; independent validation of the patterns' predictive value remains necessary.
