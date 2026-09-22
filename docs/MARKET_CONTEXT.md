# Market context and scheduled-event controls

The engine combines its stock candles with official index membership, benchmark candles and announced company meetings. These inputs can restrict new entries or inform a strategy's relative-strength checks. They do not predict news or guarantee that every material event has been announced. Position protection and exits continue when a context source is unavailable.

The Overview page separates **operational readiness** from individual entry decisions. Passing the broker, account, reconciliation, feed and machine checks does not mean that a stock passes its strategy, scheduled-event, liquidity, allocation and portfolio limits. The Market context panel shows source freshness, classification coverage, current blackout symbols and each benchmark's quote and history status.

## Official sources

| Input | Source | Actual coverage |
| --- | --- | --- |
| Nifty Total Market trading universe | [NSE security downloads](https://www.nseindia.com/static/market-data/securities-available-for-trading): `EQUITY_L.csv` and `eq_etfseclist.csv` | New entries use current Nifty Total Market constituents intersected with verified EQ-series shares and Kite instruments. Membership must be fetched on the same IST calendar day. Out-of-index existing exposure remains monitored; approved holding management is retained. Same-IST-day classification and completeness checks prevent debt instruments in Kite's broader EQ instrument type from becoming stock candidates. Existing managed exceptions remain available for exits only. |
| Company industry and current index membership | [Nifty Indices constituent files](https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500); the [NSE Nifty 500 page](https://www.nseindia.com/static/products-services/indices-nifty500-index) also publishes its constituent download | NIFTY TOTAL MARKET, NIFTY 500, NIFTY 50, NIFTY BANK, NIFTY IT, NIFTY PHARMA, NIFTY AUTO, NIFTY FMCG and NIFTY METAL files. Coverage is counted against the engine's current eligible universe. |
| Announced board meetings and financial-results meetings | [NSE corporate board meetings](https://www.nseindia.com/companies-listing/corporate-filings-board-meetings), using the official website's `corporate-board-meetings` and `event-calendar` endpoints | Records returned by both feeds within the requested date window. Financial results are distinguished from other board meetings by the published purpose and description. |
| Index quotes and historical candles | Authenticated [Kite market data](https://kite.trade/docs/connect/v3/market-data-and-instruments/) and [historical data](https://kite.trade/docs/connect/v3/historical/) | The eight fixed NSE index names above, when the account's data access returns valid quotes and candles. Tokens come from verified quote responses. |

The public NSE endpoints are used by its website; they are not a documented stable application API with an availability commitment. Access can fail or the format can change. No additional API key, mandatory environment variable, third-party feed or headline-sentiment service is used.

The public sources were checked on 17 September 2026. All eight constituent downloads and both event feeds returned usable data during that check. This is a dated connectivity check, not a promise of continued availability. Authenticated benchmark behavior is covered by fake-broker tests; that public-source check did not access a user's account.

## Classification and relative strength

The `Industry` value in a constituent file is displayed as the classification. It is not a complete sector taxonomy for every NSE stock. A company outside the downloaded lists has unknown classification; conflicting fresh classifications also remain unknown. Stale membership records are identified as stale and are not silently reused as current sector assignments.

A sector benchmark is selected only when a stock is actually a member of one of the downloaded sector indices. For example, being classified as a financial-services business does not automatically make a company a NIFTY BANK constituent. A stock can have a known industry and no available sector benchmark. Broad-market comparison uses NIFTY 50.

Files are validated for required columns, row consistency, symbols, supported equity series and real ISINs. The explicit combination of a dummy company name, dummy symbol and dummy pseudo-ISIN is excluded as an index corporate-action placeholder. Minimum row counts reject substantially truncated files. These checks do not independently prove the publisher's data is complete. Classification does not override the engine's instrument or trading-eligibility rules.

Membership is **current membership observed at the source timestamp**, not a reconstruction of membership on a historical trade date. Research using current constituents or current sector membership has selection and survivorship limitations; a benchmark's historical prices do not remove those limitations.

For benchmark history, the service requests prior daily candles over 180 calendar days and completed five-minute candles for the current session. Daily context requires at least 50 valid prior candles and a recent last trading date. Intraday context starts at 09:15 IST, must be contiguous, and excludes the forming candle. Returned strategy context excludes candles after its requested decision time. Missing, incomplete or old context is marked unavailable; no benchmark candles are synthesized.

## Scheduled-event blackouts

With the default event filter enabled, new entries require both event feeds to be fresh and valid for the queried window. A failed feed, stale response, invalid response or unverified stock produces an explicit entry block. A valid empty result means only that these feeds reported no announced event for that window.

All announced board meetings are treated conservatively as potential event risk, including financial-results meetings. The default blackout covers the event date, one calendar day before it and one calendar day after it. Dates are interpreted in India Standard Time. These are calendar days, including weekends, because the source provides a date without a reliable event time.

Matching records from the two feeds are combined for display. A cancellation, postponement or rescheduling mentioned in the description is flagged; it does not automatically erase a blackout. The service cannot infer a definitive revised schedule from free text. The Overview panel lists affected symbols and dates, and the activity log records source errors without credentials.

The filter affects new entries only. It does not prevent account reconciliation, stop or target handling, holdings authorization, protective exits or ordinary risk monitoring. Disabling it in Settings permits entries without this scheduled-event restriction; the dashboard still exposes source availability.

## Defaults and freshness

All of these controls have defaults and can be changed in Settings. They require no `.env` entries.

| Setting | Default | Meaning |
| --- | --- | --- |
| `event_risk_enabled` | `true` | Block new entries for a known blackout or unavailable scheduled-event coverage. |
| `event_blackout_before_days` | `1` | Calendar days before the event date. |
| `event_blackout_after_days` | `1` | Calendar days after the event date. |
| `market_context_max_age_minutes` | `60` | Maximum usable age of a successful event-feed response. |
| `classification_max_age_days` | `7` | Maximum usable age of a successful constituent-file response. |
| `benchmark_max_age_seconds` | `120` | Maximum age of both quote receipt and exchange timestamp. |

While connected, the engine checks context every 60 seconds. The service refreshes constituent downloads at most once per day, event data at most every 30 minutes or half its configured maximum age, and quotes at most every 30 seconds. These are minimum refresh spacings: the engine loop and shared broker rate limiter can make updates later. Completed intraday benchmark history is refreshed when a new five-minute boundary is available; daily history is collected once per exchange date.

The requested event window extends at least 14 calendar days on each side of today, expanding when a configured blackout requires more. The last successful payload, observation time and retry state are persisted in the local store. Restarting does not reset its age. A last verified payload remains usable only within its allowed age and window; a failed refresh remains visible even while that cache is still usable.

Each public request has a timeout, a bounded response size and schema validation. Redirects are rejected. Failures use exponential backoff from one minute to one hour; forcing a refresh does not bypass that backoff. URLs are fixed to the official sources. HTML errors, truncated payloads and unexpected schemas are not accepted as empty calendars.

Broker requests are read-only and pass through the broker adapter's shared rate limiting. Switching or disconnecting the broker invalidates session-dependent context immediately. Results from an old in-flight broker request cannot populate a newer session. Persisted benchmark context is not treated as an authenticated live session after restart.

## What these controls cannot establish

- Unannounced results, unexpected news, policy changes, litigation, geopolitical events and sudden exchange actions can still move prices. Fresh calendar coverage is not proof that a company has no event risk.
- Website data can be delayed, incomplete, revised or unavailable. An observed timestamp describes when the application received a response, not an independent audit of its publication quality.
- Index constituents cover a subset of the eligible NSE universe. Missing classification or sector history is explicit; the engine does not invent it.
- Historical index data and current industry labels do not model historical constituent changes. Research results must be read with the report's scope and exclusions.
- Operational checks and source freshness establish prerequisites, not profitability. Gaps, halted trading, rejected orders and fills away from expected prices remain possible.

Implementation: [`src/market-context.js`](../src/market-context.js). Tests: [`tests-node/market-context.test.js`](../tests-node/market-context.test.js), including offline cache reload, stale feeds, failures and backoff, malformed data, completed-candle boundaries and broker-session replacement. Dashboard behavior is checked in [`tests-node/market-context-ui.test.js`](../tests-node/market-context-ui.test.js).
