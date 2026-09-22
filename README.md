# StockPilot

A self-hosted Zerodha trading dashboard for **Windows, macOS and Linux**, running on **Node.js 24.9 or newer**. Sign in as the administrator, select **Start Trading**, complete Zerodha's official login, and monitor account activity and the enabled strategies. No Python runtime is required.

**Paper trading is the default.** It reads your actual Zerodha account and market data but simulates orders. Live execution requires changing Settings, valid broker permissions and the required outbound static IP. The strategies are deterministic research rules; they have not been established as profitable.

## What the application does

- Shows account cash, holdings, positions, orders, trades, strategy P&L, scanner coverage, CPU/RAM usage and a durable activity log.
- Shows startup progress and a Background page for account checks, candle downloads, active analytics batches and historical research.
- Supports intraday and swing trading. Intraday starts enabled with 100% of the strategy allocation; swing starts disabled with 0%.
- Analyzes existing holdings for exits. Automatic selling is limited to selected symbols by default; the initial selection is empty. Settings also offers **Ignore stocks I already own**, which excludes held stocks from automatic buys and sells in paper and live mode.
- Scans current Nifty Total Market constituents (about 750 stocks), verified against official index membership, NSE security lists and Kite instruments. New entries stay within this index. Existing holdings, positions and pending orders outside the index remain monitored; holding-management permissions are retained.
- Runs CPU analytics in lazy Node worker threads while one coordinated execution service handles orders.
- Evaluates 11 intraday setup families in both directions: breakout, pullback, range reversion, opening range/drive, gap continuation/reversal, VWAP reclaim/rejection, volatility squeeze and relative strength. Swing remains long-only.
- Combines 42 contextual candle formations with causal prior-session candles, completed 15-minute trend alignment and verified benchmark/sector context.
- Shows market breadth, announced-event blackouts, account exposure, operational readiness, risk blockers and the evidence supporting or opposing a signal.
- Automatically compares baseline and enhanced rules on a bounded historical sample after connection. Research can test numeric parameter changes and apply a validated candidate in the existing paper or live mode, with trial evidence and application status shown separately.
- Journals order intentions before broker mutations, reconciles actual fills and protection, and re-evaluates exposure after a restart.

Read the [logic and analytics guide](docs/LOGIC_AND_ANALYTICS.md) for formulas, order lifecycles, risk checks, recovery behavior and worked examples.

## Install and start

Install [Node.js](https://nodejs.org/en/download) version **24.9 or newer** and, for remote access, [Cloudflare's `cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). Open a terminal in this project directory. On the current Windows machine that directory is `D:\Projects\Stock`; on macOS or Linux use the directory where you copied the source.

Run these commands on all three platforms:

```sh
node --version
npm ci
npm run setup
```

Setup creates `config/settings.json` with defaults, a password hash and random security keys, and copies `.env.example` to `.env` if that file is absent. For a new installation, it prints the initial administrator password in the terminal; save it before closing that terminal. The default username is **admin**. Existing configuration is retained. These are dashboard credentials, separate from your Zerodha credentials.

Create or edit `.env` in the project directory using these **three fields only**:

```dotenv
KITE_API_KEY='your-app-api-key'
KITE_API_SECRET='your-app-api-secret'
KITE_USER_ID='AB1234'
```

Use the credentials from your [Kite developer account](https://developers.kite.trade/) and your Zerodha client ID. The same keys are shown in [.env.example](.env.example). Do not put a Zerodha password, request token or access token in this file. Empty Kite fields allow inspection of the disconnected dashboard; connecting requires all three credentials and the relevant data access.

Then run:

```sh
npm run check
npm start
```

Open **http://localhost:3000**, sign in, and open **Settings**. `npm run check` validates local configuration without contacting Zerodha; it cannot prove that broker credentials or subscriptions work. Restart after changing the three `.env` credentials. Process environment values for those credentials take precedence over `.env`.

The server listens on the local loopback interface. Keep the `npm start` terminal open. Run only one server for a given data directory; do not use a process manager's cluster mode. CPU analysis already uses its own workers.

Keep the host's automatic time synchronization enabled. The app compares the system clock with ordinary authenticated Kite response timestamps; it does not change the clock. New entries wait if that comparison is missing, stale, uncertain or outside the ten-second tolerance. A confirmed mismatch appears prominently on the dashboard and rejects incoming quotes until a valid clock observation clears it. On Windows, `w32tm /query /status` shows synchronization status; an administrator can use `w32tm /resync` to request synchronization with the configured source. This changes time for all applications. [Microsoft Windows Time tools](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings).

## Configure everything else in Settings

All non-Kite configuration has defaults and is managed from the dashboard. No extra environment variables are needed for ports, admin credentials, risk limits, worker counts or security keys. The dashboard detects its public address from the current browser request through the local tunnel; there is no `PUBLIC_URL` or development/production mode to maintain.

The **Paper trading** switch is at the top of Settings. On means simulated buys and sells; off selects real order execution. The card shows the current mode and labels unsaved changes separately. Choose the mode, click **Save settings**, then restart with `npm start` after stopping the server with **Ctrl+C**. Pause entries before saving. Simulated positions are retained; managed live positions and unresolved orders must be resolved first. Paper trading is on by default.

| Settings area | Controls and defaults |
|---|---|
| Strategies | Intraday enabled, 100% allocation; swing disabled, 0%. Allocations together must not exceed 100%. |
| Existing holdings | Selected symbols, initially empty; optionally all eligible NSE holdings, or ignore owned stocks to prevent automatic buys and sells. |
| Execution | Paper trading on by default. The top Settings switch changes both the trading mode and real-order permission together. Save and restart to apply. |
| Server | Local port `3000`; data directory `data`. |
| Risk | Risk per trade `0.0025` (0.25%); maximum position allocation `0.10` (10%); daily loss limit `0.01` (1%); maximum five bot positions. |
| Market filters | Maximum spread `0.003` (0.3%); minimum turnover estimate Rs 10,000,000. |
| Enhanced rules | All 11 intraday families enabled, including protected shorts; completed higher timeframe alignment enabled. Minimum evidence score 60/100, which is not a profit probability. |
| Market breadth | Entry filter disabled; breadth remains visible for reference. Optional thresholds apply only when explicitly enabled. |
| Announced events | Entries blocked one calendar day before through one day after an announced corporate event. Missing/stale official calendar coverage also blocks entries. |
| Account exposure | Maximum 25% in one stock, 90% gross exposure and 3% estimated stress loss relative to reference assets. Existing/manual holdings and unfilled manual orders count. |
| Correlation | Enabled; absolute daily-return correlation of at least 0.85 groups exposure, capped at 35% of reference assets. Missing history blocks an entry; opposite positions do not automatically earn hedge credit. |
| Activity limits | At most 10 new symbols attempted per day; a 30-minute entry cooldown after three consecutive realized loss events. |
| Research | Automatic after connection; 20 currently listed NSE instruments, 45 calendar days of five-minute history; estimated costs 0.1% and slippage 0.05% per side. |
| Research | Baseline and enhanced comparisons only; research never changes strategy settings. |
| Intraday times | Entry cutoff `14:45`; exit target `15:10`, both India Standard Time. |
| Analytics | Workers `0` means automatic; reserve four logical CPUs; batch size 32. |
| Machine health | New entries wait below 512 MiB free journal-disk space or 256 MiB free RAM, or above 2,000 ms event-loop delay. |
| Administrator/security | Change admin username/password and rotate generated security keys. Current password is required; dashboard sessions are revoked after a change. |

Risk inputs labeled **fraction** use `0.01` for 1%. Strategy allocations labeled **percent** use `100` for 100%.

**Settings → Application settings → Daily risk budget** offers a 0.5%–10% slider. Moving it updates an unsaved preset, with saved values and proposed rupee amounts shown together. For a chosen fraction `R` and `N` maximum positions, the preset sets the daily loss limit and estimated account stress budget to `R`, planned risk per trade to `R/N`, and the per-position and per-stock allocation caps to `1/N`; it enables account exposure checks. For example, 10% with five slots gives 2% planned risk per trade and 20% allocation caps. The per-trade and per-position percentages use each strategy's allocated capital; the daily limit uses trading capital; account stress and stock concentration use reference assets, including existing holdings. These are explicit allocation rules, not optimized parameters or a forecast. Cash, spread, turnover, gross exposure, correlation and signal checks still apply. Editing a linked field manually switches the preview to Custom settings. Changing Maximum positions recalculates the split while the preset is linked. Save and restart through the existing application-settings workflow to apply it; merely moving the slider does not change active trading.

The daily stop measures realised plus unrealised bot P&L for the day. At the threshold the engine blocks new entries and requests bot exits; execution can occur beyond the threshold, so it is not a guaranteed loss cap. Trading equity shows the app's budget plus bot profits/losses. The Zerodha available-cash card uses the same eligible cash figure as the funding logic, excluding collateral and extra margin. A 10% daily loss budget does not restrict investment to 10% of cash, and an available cash balance does not override allocation or risk limits.

Trading capital comes from the connected account's cash information; there is no manually entered starting capital. Same-day deposits count even when Zerodha's raw cash field still shows the opening balance; used margin, collateral and extra margin remain excluded from available cash. Paper simulation retains its initialized capital and journal across restarts so signing in again does not reset simulated gains, losses or exposure. Existing share value and collateral are not automatically spendable cash. The guide explains capital and allocation calculations.

An initially unfunded account can still start. The dashboard shows **Waiting for funds**, keeps monitoring, and uses subsequent verified balance updates without another Start click. Authorized existing holdings and previously managed positions can still be managed. New long and short entries wait for funding and all other checks. Adding funds never overrides Pause entries or a risk halt. Paper capital is seeded only once; later real deposits or withdrawals do not replace its existing simulated bankroll.

Strategy/holding settings apply without a server restart after entries are paused and managed live positions and pending orders are resolved. Paused paper positions and their results are retained and do not block settings changes. Saved live exposure from another mode still blocks changes. Application settings require the same checks; saving them stops the engine and marks the server for restart. Stop with **Ctrl+C**, wait for shutdown, then run `npm start` again. Settings displays the specific reason when saving is blocked. Administrator/password changes take effect immediately and require another dashboard login.

Settings are stored in `config/settings.json`; strategy permissions and journals are in the SQLite database under the selected data directory. Keep both directories and `.env` private and backed up. Generated encryption keys are necessary to read saved broker sessions; rotate them using Settings instead of replacing them by hand.

**Ignore stocks I already own** uses the latest verified account holdings, including unsettled and pledged shares and today's delivery buys. It overrides any saved symbol selection. Ignored holdings remain visible and count toward account risk. Pause entries and resolve managed live positions and pending orders before changing this setting; it does not remove existing order protection. Simulated positions are retained.

## Connect through Cloudflare Tunnel

With `npm start` running on its default port, open a second terminal:

```sh
npm run tunnel
```

This runs `cloudflared tunnel --url http://127.0.0.1:3000` and requires `cloudflared` to be installed and available on your PATH. The explicit IPv4 address matches the server's local listener and avoids `localhost` resolving to the unbound IPv6 address `::1`. If you change the application port in Settings, use that port in the tunnel command too.

Open the printed HTTPS address, for example `https://your-tunnel.trycloudflare.com`, and sign in there. Keep the original public Host header when configuring a tunnel; do not rewrite it to localhost. After changing the tunnel command, stop the old `cloudflared` process with **Ctrl+C** and run `npm run tunnel` again. A restarted Quick Tunnel can have a new public address; update both Kite URL fields if it changes.

In dashboard **Settings**, copy the detected callback URLs into your Kite app in the [developer console](https://developers.kite.trade/):

| Kite field | Example |
|---|---|
| Redirect URL | `https://your-tunnel.trycloudflare.com/auth/kite/callback` |
| Postback URL | `https://your-tunnel.trycloudflare.com/api/kite/postback` |

The redirect returns your browser after broker login. The postback receives signed broker order notifications; opening it in a browser is not a valid test. The server validates notifications and separately reconciles broker state before treating an order as filled. Postbacks cover orders placed through this API app; streaming and account reconciliation also observe other account activity. [Kite authentication](https://kite.trade/docs/connect/v3/user/), [postback documentation](https://kite.trade/docs/connect/v3/postbacks/).

Select **Start Trading** from that HTTPS dashboard and complete Zerodha's login in the same browser. Dashboard sessions and the pending broker login are bound to their origin: starting on localhost and returning to the tunnel will not complete the same session.

Quick Tunnels use temporary random hostnames, have no uptime guarantee, and do not support Server-Sent Events. StockPilot uses periodic HTTP polling on `trycloudflare.com` and falls back to polling when streaming fails elsewhere. For continued use, configure a managed tunnel with a stable hostname. [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

When a Quick Tunnel's hostname changes, visit the new address, sign in, and update **both Kite URL fields** using Settings. You do not need to edit `.env` or restart the app just because the hostname changed. If Cloudflare Access or browser challenges protect the site, Zerodha must still be able to POST to the exact postback path without interactive authentication; that path has its own checksum validation.

The tunnel exposes incoming dashboard/callback traffic. It does **not** route outgoing broker requests through a fixed public IP. Zerodha requires a whitelisted static IP for API order placement, effective 1 April 2026; market-data streams and other read APIs can use other IPs. Whitelist this machine's actual static public outbound IPv4 address in your Kite developer account. StockPilot uses IPv4 for Kite REST requests, including login token exchange and orders, so dual-stack connections cannot silently use an unlisted IPv6 address. This does not make a dynamic ISP address static. A tunnel hostname does not replace this requirement. [Zerodha static-IP requirements](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/static-ip).

For local-only use, visit `http://localhost:3000` and register the corresponding local Redirect URL if connecting locally. Internet postbacks cannot reach localhost, so omit the Postback URL and rely on broker streaming/reconciliation. Remote mobile and desktop access use the HTTPS tunnel address.

## When Zerodha asks for holdings authorization

In live mode, selected existing holdings can be managed with DDPI/POA or sufficient current-day electronic authorization. When authorization is missing, the dashboard shows **Zerodha holdings authorization needed**, with the affected symbols and quantities. Existing-holding selection in Settings still controls which shares the program may manage.

1. Select **Authorize holdings**. The app requests an authorization page from Kite and opens it on the official Zerodha site in a new tab.
2. Complete the TPIN/OTP steps on Zerodha/CDSL. StockPilot never asks for, receives or stores your TPIN or OTP.
3. Return to the dashboard and select **Check authorization**. Returning to the tab also requests a background check, but a broker rejection requires an explicit Check. The server reads current broker authorization dates and remaining quantities; a successful browser page alone does not authorize a sale.
4. Once verified, the running engine re-evaluates current holdings, prices and exit conditions. Authorization itself submits no sell order and does not resume a paused engine.

Each request includes up to 100 holdings. If more need authorization, complete one batch, check it, then authorize the remaining batch. If a popup is blocked, use **Open Zerodha authorization page** in the banner. If Kite cannot create the page, open **Kite → Holdings → Authorise** manually, then return and select **Check authorization**. [Kite holdings authorization API](https://kite.trade/docs/connect/v3/portfolio/#holdings-authorisation), [Zerodha authorization instructions](https://support.zerodha.com/category/trading-and-markets/trading-faqs/general/articles/tpin-preauthorisation).

Electronic authorization lasts for the trading day and needs renewal on a later day. An existing GTT does not remove this requirement; without DDPI/POA its future sale can be rejected while the app is offline. **New automated swing buys still require verified DDPI/POA**, because today's consent cannot ensure an unattended exit on another day. Normal intraday cover orders and paper trading do not use this demat authorization flow. [Zerodha authorization validity](https://support.zerodha.com/category/trading-and-markets/trading-faqs/general/articles/validity-of-cdsl-tpin-authorisation), [sell GTT authorization](https://support.zerodha.com/category/trading-and-markets/charts-and-orders/gtt/articles/why-was-my-sell-gtt-order-rejected).

## Startup progress and background work

After **Start Trading** and any required Zerodha login, the dashboard shows the current setup step: verifying the account, downloading balances, holdings, positions, orders and trades, loading NSE instruments, preparing the market feed, and checking recovery and risk. The progress bar counts completed setup steps; it is not a time estimate. The dashboard remains available while these requests run.

Setup reaching 100% does not mean every NSE stock has enough history or that a trade can be placed. Candle downloads continue in the background, and **Entry readiness** explains conditions such as a closed market, clock mismatch, missing funds or incomplete recovery. These are waiting conditions, not an indefinitely running setup step.

Open **Background** to see current work, the symbol being downloaded where available, completed/total counts, retries, the analytics queue and active worker batches, and research progress. Five-minute history counts each successfully warmed stock once per session and universe, so feed gaps and repeat downloads do not reduce or double-count completed progress. A separate currently-loaded count shows data awaiting refresh. The warmup counter resets on server restart, a new trading day or a changed stock universe. Daily history counts current usable coverage, including valid cached history, and can cover holdings and risk checks even when swing entries are disabled. Downloading all needed data takes time because broker requests are rate limited.

Warmup accepts the 72 uninterrupted five-minute candles from 09:15 through 15:10 that Kite supplies for CAS stocks from 3 August 2026, as well as normal history ending at 15:25. These observed candles seed indicators; the 15:10 price is not treated as the later auction close for gap strategies. Invalid or gapped history still waits. Managed positions retain download priority, followed by stocks never warmed this session, then refreshes of previously warmed stocks. [Zerodha's explanation of CAS candle history](https://kite.trade/forum/discussion/16171/historical-data-api-missing-minute-candles-after-15-14).

Five-minute warmup overlaps downloads instead of waiting for each stock's response. All historical requests (including daily history, research and market context) share a maximum of three starts per rolling 1.05-second window and six unfinished requests. The timing margin keeps starts below Kite's three-per-second historical API limit. Later requests can start while earlier responses are pending; account and order requests retain their separate serialized queue. Background lists the warmup symbols currently being processed. HTTP 429 pauses further historical starts, while valid responses already in flight can still finish. Cancellation, reconnects and universe changes discard obsolete warmup results.

**Activity** groups routine scanner candidates and blocked entry decisions into approximately five-minute summaries. Candle coverage is logged when it changes, at most once per five minutes plus completion; Background continues to show live progress. Orders, fills, account changes and errors remain individual events. Errors include **What to check**, with links to the relevant app setting or official Zerodha guidance. This also works for previously saved errors.

**Clear All** permanently deletes all saved activity entries, including entries outside the current search or severity filter. Export full history first if you need a copy. Trading journals, open orders, positions, settings and login sessions are retained. New events continue normally, and other open dashboards receive the clear on their next update.

**Pause entries** prevents a pending startup from enabling trading. An in-flight broker request may still finish before startup reports cancellation. Account monitoring and analysis continue after connection, and exits for already managed positions remain active. Background status describes current work; **Activity** retains the durable event history and **Research** contains the detailed comparison report.

## Controls, shutdown and restart

| Action | Result |
|---|---|
| Start/Resume Trading | Connects if needed, refreshes account state and enables entry decisions only after recovery and risk checks pass. |
| Pause entries | Stops new entries and requests cancellation of known pending entries. Monitoring and exits for managed positions continue. |
| Close managed positions | Requests exits for bot positions and already adopted existing holdings. It does not sell unselected/unadopted holdings or guarantee immediate fills. |
| Holdings authorization needed | Blocks new entries while existing positions remain monitored. The affected delivery sale/protection waits for verified authorization. |
| Close browser / sign out | Ends dashboard access; server trading continues. |
| Stop only `cloudflared` | Removes remote dashboard/callback access; the local trading engine continues. |
| Ctrl+C in the app terminal | Requests orderly engine shutdown, including pending-entry cancellation attempts. It does not liquidate positions. Wait until shutdown completes. |

To restart, run `npm start`, reconnect the tunnel if necessary, sign in, and select **Start/Resume Trading**. A valid saved broker session can restore monitoring automatically; new entries remain paused until Start. Expired sessions require official Zerodha login again. Kite normally expires an access token at 06:00 the following day and can invalidate it earlier. [Kite token lifecycle](https://kite.trade/docs/connect/v3/user/).

Recovery verifies balances, holdings, orders, positions, fills and protection against the saved journal. It discards stale decisions, prioritizes existing risk, loads recent completed candles and waits for fresh executable prices. Decisions use the current time: intraday entries stop at 14:45 IST; managed intraday positions past 15:10 or carried from an earlier day become exit candidates during an open session. Swing has a separate 15:15 entry cutoff.

During shutdown, local targets, trailing rules and scheduled exits cannot run. Broker-held protection can remain active but cannot guarantee execution. Uncertain order acknowledgements or conflicting ownership remain blocked for review; repeated restarting does not authorize duplicate orders. See the dashboard's recovery status and [detailed recovery rules](docs/LOGIC_AND_ANALYTICS.md#10-controls-recovery-and-logs).

## Moving from the previous Python version

1. Stop the Python server and confirm it has exited. Never run both versions against the same account/journal simultaneously, even on different ports.
2. With the old server stopped, back up its complete data directory and `.env`. Also back up `config/` if present. Do not copy only a live SQLite file while leaving its WAL files behind.
3. Keep the same data directory and legacy `.env` for the first `npm run setup`. The loader imports recognized legacy settings, admin hash and encryption keys once when creating `config/settings.json`; an existing settings file is retained.
4. Run `npm run check`, then `npm start`. Review Settings and verify recovery before resuming. Existing SQLite trading/audit journals and encrypted sessions use compatible formats. Old rupee allocations are normalized into percentages of their combined allocation; review them because formerly unallocated cash can now become allocated. Legacy paper journals without a saved starting baseline initialize it from current verified cash; old manually entered capital is no longer used.
5. After setup preserves the legacy configuration, `.env` only needs the three Kite fields. Keep the private backup until migration and recovery have been verified.

When moving to another operating system, copy source, `.env`, `config/` and the complete stopped data directory, then run `npm ci` on the destination. Do not copy `node_modules`; native dependencies must match the new platform. An absolute data directory from Windows must be changed to the correct destination path while the application is stopped. Do not delete the journal to make startup appear clean while real account exposure remains.

## Resources, data and validation

Automatic live-analytics capacity uses the detected available CPU estimate minus four, with at least one worker. On macOS/Linux it respects the runtime's usable parallelism. On supported Windows builds a bounded, read-only CIM probe handles Node versions that report just one processor group. This machine reports **96 physical / 192 logical CPUs**, so the verified wider estimate gives a ceiling of **188 worker threads**. Runtime CPU counts and any sampled usage subset remain visible. This is a scheduling estimate; live-analytics workers use operating-system placement. Research has its own CPU-pinning setting described below. Workers start as batches arrive and retire after being idle. Broker rate limits and cold historical downloads often dominate startup time. Only one coordinated execution service sends orders.

Enhanced intraday indicators can warm from the previous completed session while VWAP resets at 09:15. Opening-drive setups can become eligible after three completed current-session candles (09:30), provided prior history, higher timeframe alignment and other conditions pass. There is no promise of a trade at that time. Without prior history, indicators need sufficient current-session candles. The optional baseline keeps its 21-bar minimum (approximately 11:00); swing needs 55 completed daily candles. Nifty Total Market warmup needs roughly 750 stock downloads instead of the full NSE universe; retries, other historical requests and missing candles still affect completion time. Missing or stale information prevents entries. Enhanced rules use EMA, Wilder RSI/ATR/ADX, MACD, Bollinger Bands, VWAP, relative volume and contextual candle patterns. Workers have a 15-second job timeout; these remain deterministic rules rather than a trained prediction model.

Run automated checks with:

```sh
npm test
```

`npm run benchmark` runs a synthetic 9,000-symbol analytics pass with no broker connection. Use `npm run benchmark -- 1000` for a smaller check. On this machine the recorded pass completed 9,000 valid analyses in 5.293 seconds with 188 workers and about 4.843 GiB peak process memory. This measures the supplied synthetic workload, not market-feed latency or order execution speed.

Tests exercise application security, strategy calculations, real analytics workers, broker adapters, order recovery and UI polling with local fixtures. They do not establish profitability or prove real broker/tunnel operation. Paper fills omit order-queue dynamics; paper swing does not fully simulate the live GTT/trailing lifecycle. The [analytics guide](docs/LOGIC_AND_ANALYTICS.md) documents these differences.

The dependency lock includes a patched `serialize-javascript` override because the Kite SDK includes an older Mocha test dependency in its published runtime dependencies. StockPilot uses Node's built-in test runner.

## Understand decisions and review research

The Overview page's **Decision controls** shows the live breadth sample, account exposure by stock, current restrictions and ranked candidates. Expand **Indicators & evidence** under Latest analysis to inspect EMA, RSI, MACD, ADX, Bollinger Bands, ATR, VWAP, relative volume and detected patterns. A score describes agreement among the implemented rules; it does not estimate the chance of making money. A candidate still needs current account, price, liquidity and risk checks.

New entries also require **1.5:1 reward/risk after estimated costs** by default, adjustable in Settings. The engine checks the submitted limit price and rounded stop, subtracts estimated entry/exit fees from target profit, and adds fees and adverse exit slippage to planned stop risk. It skips insufficient reward without moving the signal's target or stop to qualify. This applies to paper/live longs, intraday shorts and swing entries. Research uses the same check at its next-open simulated entry with its configured cost estimates; its assumptions show the threshold and rejection count. Execution currently uses a 0.1% fee allowance per fill and 0.05% adverse exit slippage; these are estimates, not actual broker charges or guaranteed loss bounds. The default threshold is a policy to evaluate, not an optimized profitability claim.

Open **Research** after connecting Zerodha. Automatic research is enabled by default; **Run analysis** requests a fresh comparison, **Refresh** reads progress, and **Cancel research** stops that research job without pausing trading. No symbols, cash amount or additional secrets need to be entered. Historical downloads use the same broker rate limiter as account activity, so the collection takes time. The most recent completed report remains available after a restart or a cancelled replacement run.

At the top of Research, choose a stock count or **All constituents** under **Stocks from Nifty Total Market**, then select **Save research settings**. The existing stock count is retained (20 by default). A smaller count gives a reproducible sample spread across the index's industry groups; All constituents includes every eligible member with usable broker history. Both baseline and enhanced rules receive the same data. Full coverage needs more downloads, RAM and calculation time. Saving applies to the next manual or automatic run without pausing trading or starting a run immediately; it waits while research is active or a server restart is pending.

Membership comes from the official [Nifty Total Market constituent file](https://www.niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv), covering approximately 750 stocks. The app requires fresh, validated membership and never substitutes stocks outside that index. Corporate-action placeholders are excluded; missing broker instruments, ineligible stocks and unavailable histories are reported. Selection uses a stable industry order without looking at prices or returns. Current membership introduces survivorship bias and does not reconstruct historical constituents. **Industry coverage** shows the stocks and industries with usable data in the selected report.

The **Baseline vs enhanced rules** report compares the original simple breakout with the configured additional rules on identical candles and execution assumptions. It shows net return, drawdown, closed trades, win rate, expectancy, costs, chronological 60%/20%/20% reporting periods and data coverage. These partitions are descriptive; trades, open exposure and indicator history carry across their boundaries. Parameter refinement, parameter-set selection and automatic parameter application have been removed. Already saved strategy thresholds are retained; old queued parameter changes are discarded when the updated service starts.

Intraday research requests completed five-minute candles over the configured lookback, excluding today (45 calendar days by default). Swing research uses daily candles over seven times that lookback. When both are enabled, their separate comparisons are retained together. Available historical NIFTY 50 and verified sector-index series use the same requested window; missing context is reported. The app comparison limit is five million candles per interval, including context. Each baseline/enhanced pass has a dataset-based budget of one to 30 minutes; full-index research can still time out.

Comparison workers evaluate stock signals at each historical timestamp, while one coordinator maintains chronological decisions and a shared portfolio. Capacity is bounded by CPUs, stock count and available RAM. **Parallel comparison workers** (`research_workers`) defaults to automatic allocation; a positive value caps the worker count. Existing saved worker limits migrate from the retired tuning setting. **Research CPU scheduling** supports verified pinning or operating-system scheduling. The page reports actual worker activity and pinning status, without claiming exclusive CPU ownership. The overall progress bar spans collection and comparisons, with per-stage candle counts below it. Counts under **Current historical candle** reset for each timestamp. Active research refreshes every two seconds while visible.

Automatic research checks readiness every 30 seconds. Transient failures retry with increasing delays up to 30 minutes. HTTP 429 pauses both manual and automatic research until the cooldown expires; valid downloaded candles remain cached. Authentication and permission errors require attention to the session or data access. A local calculation timeout is separate from broker rate limiting: use fewer stocks or fewer **Research days** in Settings before retrying. Missing instruments or history remain explicit in the report, and raw broker responses and credentials are excluded from diagnostics. Cancel suppresses automatic retries for that day/configuration until an explicit run or a changed scope.

The simulation uses completed-candle signals, subsequent-candle entries, whole-share quantities, costs and conservative stop/target assumptions. Gaps are handled using observed prices without invented fills; unresolved positions stay explicit. It omits historical live breadth, account holdings, correlation, broker execution/protection, demat authorization, corporate actions and market queues. Research does not change trading settings or place orders. See [research methodology and limits](docs/LOGIC_AND_ANALYTICS.md#12-historical-research-and-its-limits).

For an independent dataset, run `npm run research -- candles.json report.json 100000` or `npm run research -- candles.csv report.json 100000 day`. This offline-only command requires an explicit hypothetical capital amount because it never connects to an account. It does not add a capital setting to the app. CSV columns are `symbol,time,open,high,low,close,volume`; JSON uses `{ "interval": "5minute", "symbols": { "INFY": [{ "time": "2026-09-16T09:15:00+05:30", "open": 1500, "high": 1502, "low": 1499, "close": 1501, "volume": 1000 }] } }`. Supply sufficient chronological history for the strategies. Input is limited to 64 MiB and 250,000 candles, and output must be a new file.

To make a paired recovery backup, stop the server and run `npm run backup -- "D:\PrivateBackups\stockpilot-2026-09-17"` on Windows, or use a new private directory on macOS/Linux. The parent directory must exist. The command refuses an active server and existing destinations, checks the SQLite snapshot, and stores matching `.env`, `config/settings.json`, database and checksums. It contains credentials and encryption keys; keep it private. Restore the three files together while stopped, placing the database at the `data_dir` in the matching configuration. A restored snapshot still requires current broker reconciliation before trading.

Backups copy the literal `.env` file. If the backup process has a Kite environment override that differs from that file, the command stops before creating the backup. Process and service environment secrets are never exported; verify any separately managed service credentials match the intended `.env` before backup and restore. Data directories and backup destinations cannot be inside `public/`, including directory aliases, because those files are publicly served.

Run `npm test` for unit/integration checks. For real browser checks, run `npx playwright install chromium` once, then `npm run test:browser`. Browser verification uses isolated temporary configuration, synthetic account data and desktop/mobile viewports; it never connects to Zerodha or places orders. Operational scope and remaining external verification are recorded in [acceptance criteria](docs/ACCEPTANCE.md); public-data coverage is explained in [market context](docs/MARKET_CONTEXT.md).

| Symptom | Check |
|---|---|
| `node:sqlite` or engine-version error | Use Node.js 24.9 or newer, then run `npm ci`. |
| PowerShell blocks `npm.ps1` | Use the corresponding `npm.cmd` command in that terminal. |
| `cloudflared` not found | Install it and make its directory available on PATH. |
| Tunnel returns 502 or logs `dial tcp [::1]:3000` connection refused | Check `http://127.0.0.1:3000/health`; server and tunnel must target the same configured port. Use `npm run tunnel` with its explicit `127.0.0.1` target, and restart an old tunnel that still uses `localhost`. |
| Redirect login expires | Begin on the exact HTTPS origin registered in Kite, in the same browser. Try Start Trading again after updating the URLs. |
| No buying after connection | Inspect recovery, market hours, warmup, allocation and activity reasons; connection does not imply a qualifying signal. |
| Clock out of sync / system clock warning / near-zero fresh feed coverage | Synchronize the host clock. On Windows, run `w32tm /resync` from an administrator terminal, or use Date & time settings → Sync now. The app checks new broker responses automatically and clears the warning once alignment is verified. Paused trading stays paused; the app never shifts exchange timestamps or relaxes the freshness limit. |
| Holdings authorization banner remains | Finish the official TPIN/OTP flow, then select Check authorization; insufficient or prior-day broker authorization keeps sales blocked. |
| Settings say restart required | Stop the app and run `npm start`; update the tunnel target if the local port changed. |
| Account mismatch or unresolved exposure | Restore the correct account's data/configuration and reconcile broker activity before resuming. |

Keep system time synchronized. Trading uses India Standard Time regardless of host timezone; there is no authoritative holiday/special-session calendar, so fresh exchange data is also required.
