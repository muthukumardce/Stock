# StockPilot

A self-hosted Zerodha trading dashboard for **Windows, macOS and Linux**, running on **Node.js 24.9 or newer**. Sign in as the administrator, select **Start Trading**, complete Zerodha's official login, and monitor account activity and the enabled strategies. No Python runtime is required.

**Paper trading is the default.** It reads your actual Zerodha account and market data but simulates orders. Live execution requires changing Settings, valid broker permissions and the required outbound static IP. The strategies are deterministic research rules; they have not been established as profitable.

## What the application does

- Shows account cash, holdings, positions, orders, trades, strategy P&L, scanner coverage, CPU/RAM usage and a durable activity log.
- Supports intraday and swing trading. Intraday starts enabled with 100% of the strategy allocation; swing starts disabled with 0%.
- Analyzes existing holdings for exits. Automatic selling is limited to selected symbols by default; the initial selection is empty. You can select symbols or all eligible NSE holdings in Settings.
- Scans the available NSE EQ universe, including any ETFs classified as EQ, using completed candles and fresh market data.
- Runs CPU analytics in lazy Node worker threads while one coordinated execution service handles orders.
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

## Configure everything else in Settings

All non-Kite configuration has defaults and is managed from the dashboard. No extra environment variables are needed for ports, admin credentials, risk limits, worker counts or security keys. The dashboard detects its public address from the current browser request through the local tunnel; there is no `PUBLIC_URL` or development/production mode to maintain.

| Settings area | Controls and defaults |
|---|---|
| Strategies | Intraday enabled, 100% allocation; swing disabled, 0%. Allocations together must not exceed 100%. |
| Existing holdings | Selected symbols, initially empty; optionally all eligible NSE holdings. |
| Execution | Paper mode; real order execution disabled. Both live mode and live execution must be enabled for real orders. |
| Server | Local port `3000`; data directory `data`. |
| Risk | Risk per trade `0.0025` (0.25%); maximum position allocation `0.10` (10%); daily loss limit `0.01` (1%); maximum five bot positions. |
| Market filters | Maximum spread `0.003` (0.3%); minimum turnover estimate Rs 10,000,000. |
| Intraday times | Entry cutoff `14:45`; exit target `15:10`, both India Standard Time. |
| Analytics | Workers `0` means automatic; reserve four logical CPUs; batch size 32. |
| Administrator/security | Change admin username/password and rotate generated security keys. Current password is required; dashboard sessions are revoked after a change. |

Risk inputs labeled **fraction** use `0.01` for 1%. Strategy allocations labeled **percent** use `100` for 100%.

Trading capital comes from the connected account's cash information; there is no manually entered starting capital. Paper simulation retains its initialized capital and journal across restarts so signing in again does not reset simulated gains, losses or exposure. Existing share value and collateral are not automatically spendable cash. The guide explains capital and allocation calculations.

An account with no available cash can still start management of authorized existing holdings or previously managed positions. New buys remain blocked until their funding and risk checks pass.

Strategy/holding settings apply without a server restart after entries are paused and managed exposure and pending orders are resolved. Application settings require the same checks; saving them stops the engine and marks the server for restart. Stop with **Ctrl+C**, wait for shutdown, then run `npm start` again. The UI tells you when a restart is required. Administrator/password changes take effect immediately and require another dashboard login.

Settings are stored in `config/settings.json`; strategy permissions and journals are in the SQLite database under the selected data directory. Keep both directories and `.env` private and backed up. Generated encryption keys are necessary to read saved broker sessions; rotate them using Settings instead of replacing them by hand.

## Connect through Cloudflare Tunnel

With `npm start` running on its default port, open a second terminal:

```sh
cloudflared tunnel --url http://localhost:3000
```

Open the printed HTTPS address, for example `https://your-tunnel.trycloudflare.com`, and sign in there. If localhost resolves to an unavailable IPv6 listener, use `--url http://127.0.0.1:3000` instead. Keep the original public Host header when configuring a tunnel; do not rewrite it to localhost.

In dashboard **Settings**, copy the detected callback URLs into your Kite app in the [developer console](https://developers.kite.trade/):

| Kite field | Example |
|---|---|
| Redirect URL | `https://your-tunnel.trycloudflare.com/auth/kite/callback` |
| Postback URL | `https://your-tunnel.trycloudflare.com/api/kite/postback` |

The redirect returns your browser after broker login. The postback receives signed broker order notifications; opening it in a browser is not a valid test. The server validates notifications and separately reconciles broker state before treating an order as filled. Postbacks cover orders placed through this API app; streaming and account reconciliation also observe other account activity. [Kite authentication](https://kite.trade/docs/connect/v3/user/), [postback documentation](https://kite.trade/docs/connect/v3/postbacks/).

Select **Start Trading** from that HTTPS dashboard and complete Zerodha's login in the same browser. Dashboard sessions and the pending broker login are bound to their origin: starting on localhost and returning to the tunnel will not complete the same session.

Quick Tunnels use temporary random hostnames, have no uptime guarantee, and do not support Server-Sent Events. StockPilot uses periodic HTTP polling on `trycloudflare.com` and falls back to polling when streaming fails elsewhere. For continued use, configure a managed tunnel with a stable hostname. [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

When a Quick Tunnel's hostname changes, visit the new address, sign in, and update **both Kite URL fields** using Settings. You do not need to edit `.env` or restart the app just because the hostname changed. If Cloudflare Access or browser challenges protect the site, Zerodha must still be able to POST to the exact postback path without interactive authentication; that path has its own checksum validation.

The tunnel exposes incoming dashboard/callback traffic. It does **not** route outgoing broker requests through a fixed public IP. Zerodha requires a whitelisted static IP for API order placement, effective 1 April 2026; market-data streams and other read APIs can use other IPs. Whitelist this machine's actual static public outbound IP in your Kite developer account. A tunnel hostname does not replace this requirement. [Zerodha static-IP requirements](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/static-ip).

For local-only use, visit `http://localhost:3000` and register the corresponding local Redirect URL if connecting locally. Internet postbacks cannot reach localhost, so omit the Postback URL and rely on broker streaming/reconciliation. Remote mobile and desktop access use the HTTPS tunnel address.

## When Zerodha asks for holdings authorization

In live mode, selected existing holdings can be managed with DDPI/POA or sufficient current-day electronic authorization. When authorization is missing, the dashboard shows **Zerodha holdings authorization needed**, with the affected symbols and quantities. Existing-holding selection in Settings still controls which shares the program may manage.

1. Select **Authorize holdings**. The app requests an authorization page from Kite and opens it on the official Zerodha site in a new tab.
2. Complete the TPIN/OTP steps on Zerodha/CDSL. StockPilot never asks for, receives or stores your TPIN or OTP.
3. Return to the dashboard and select **Check authorization**. Returning to the tab also requests a background check, but a broker rejection requires an explicit Check. The server reads current broker authorization dates and remaining quantities; a successful browser page alone does not authorize a sale.
4. Once verified, the running engine re-evaluates current holdings, prices and exit conditions. Authorization itself submits no sell order and does not resume a paused engine.

Each request includes up to 100 holdings. If more need authorization, complete one batch, check it, then authorize the remaining batch. If a popup is blocked, use **Open Zerodha authorization page** in the banner. If Kite cannot create the page, open **Kite → Holdings → Authorise** manually, then return and select **Check authorization**. [Kite holdings authorization API](https://kite.trade/docs/connect/v3/portfolio/#holdings-authorisation), [Zerodha authorization instructions](https://support.zerodha.com/category/trading-and-markets/trading-faqs/general/articles/tpin-preauthorisation).

Electronic authorization lasts for the trading day and needs renewal on a later day. An existing GTT does not remove this requirement; without DDPI/POA its future sale can be rejected while the app is offline. **New automated swing buys still require verified DDPI/POA**, because today's consent cannot ensure an unattended exit on another day. Normal intraday cover orders and paper trading do not use this demat authorization flow. [Zerodha authorization validity](https://support.zerodha.com/category/trading-and-markets/trading-faqs/general/articles/validity-of-cdsl-tpin-authorisation), [sell GTT authorization](https://support.zerodha.com/category/trading-and-markets/charts-and-orders/gtt/articles/why-was-my-sell-gtt-order-rejected).

## Controls, shutdown and restart

| Action | Result |
|---|---|
| Start/Resume Trading | Connects if needed, refreshes account state and enables entry decisions only after recovery and risk checks pass. |
| Pause entries | Stops new buys and requests cancellation of known pending entries. Monitoring and exits for managed positions continue. |
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

Automatic analytics capacity is logical CPUs minus four, with at least one worker. This machine reports **192 logical CPUs**, so its automatic ceiling is **188 worker threads**. Workers start as batches arrive and retire after being idle; they do not consume every core constantly. Broker rate limits and cold historical downloads often dominate startup time. Only one coordinated execution service sends orders.

Intraday needs 21 contiguous completed five-minute candles and cannot qualify before approximately 11:00 IST. Swing needs 55 completed daily candles. Full-universe historical warmup can take tens of minutes. Missing or stale information prevents entries. Rules use breakouts, volume, candle shape, moving averages and ATR; RSI and regression diagnostics are explanatory metrics, not an AI prediction model.

Run automated checks with:

```sh
npm test
```

Tests exercise application security, strategy calculations, real analytics workers, broker adapters, order recovery and UI polling with local fixtures. They do not establish profitability or prove real broker/tunnel operation. Paper fills omit order-queue dynamics; paper swing does not fully simulate the live GTT/trailing lifecycle. The [analytics guide](docs/LOGIC_AND_ANALYTICS.md) documents these differences.

The dependency lock includes a patched `serialize-javascript` override because the Kite SDK includes an older Mocha test dependency in its published runtime dependencies. StockPilot uses Node's built-in test runner.

| Symptom | Check |
|---|---|
| `node:sqlite` or engine-version error | Use Node.js 24.9 or newer, then run `npm ci`. |
| PowerShell blocks `npm.ps1` | Use the corresponding `npm.cmd` command in that terminal. |
| `cloudflared` not found | Install it and make its directory available on PATH. |
| Tunnel returns 502 | Check `http://127.0.0.1:3000/health`; server and tunnel must target the same configured port. |
| Redirect login expires | Begin on the exact HTTPS origin registered in Kite, in the same browser. Try Start Trading again after updating the URLs. |
| No buying after connection | Inspect recovery, market hours, warmup, allocation and activity reasons; connection does not imply a qualifying signal. |
| Holdings authorization banner remains | Finish the official TPIN/OTP flow, then select Check authorization; insufficient or prior-day broker authorization keeps sales blocked. |
| Settings say restart required | Stop the app and run `npm start`; update the tunnel target if the local port changed. |
| Account mismatch or unresolved exposure | Restore the correct account's data/configuration and reconcile broker activity before resuming. |

Keep system time synchronized. Trading uses India Standard Time regardless of host timezone; there is no authoritative holiday/special-session calendar, so fresh exchange data is also required.
