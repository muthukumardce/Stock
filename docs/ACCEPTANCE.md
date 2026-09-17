# Capability acceptance record

This record defines reviewable completion criteria for the supported product: an NSE equity bot with intraday long/short strategies and optional long delivery/swing trading through Kite Connect. Demonstrated profitability is outside this work. A count of indicators or patterns is not a quality score, and this scope does not claim every possible trading strategy, derivatives, or exchange co-location trading.

| Area | Required evidence |
| --- | --- |
| Strategy decisions | Coordinated breakout, pullback, range reversion, opening range/drive, gap continuation/reversal, VWAP reclaim/rejection, squeeze, and relative strength; completed higher timeframe context; deterministic explanations and directional exits. |
| Data integrity | Causal completed candles; no future context; explicit warmup, missing data, stale quotes and market-context coverage; rate limited history and feed recovery. |
| Execution | Journal before broker I/O; long/short cover ownership and signed broker reconciliation; partial fills, rejections, ambiguous acknowledgements and cancellation races; no automatic duplicate submission. |
| Account risk | Current available funds, existing holdings and manual exposure; stock/gross/stress/correlation caps; loss limits/cooldown; liquidity and earnings-event entry gates. |
| Recovery | Restart reauthenticates the account, reconciles real orders and holdings, restores monitoring, and reanalyses current completed data before new entries. |
| Research | Shared decision logic; next-bar fills; explicit fees/slippage, gaps, short cash reservations and unresolved positions; repeatable bounded background research. |
| Operations | Authenticated responsive dashboard, live decisions/account/logs, operational readiness, portable setup, shutdown/backup guidance, and meaningful automated verification. |
| Broker integration | Read-only authenticated rehearsal, live feed and account reconciliation, and user-operated controlled execution verification against the real account. |

Implementation and test results are recorded below as work completes. Public documentation and mocks cannot substitute for broker integration evidence. No real orders are submitted as part of development verification.

## Verification on 17 September 2026

- `npm test`: 414 unit/integration checks passed on Windows with Node 24.9.0; zero failures and one file-symlink test skipped because this Windows session lacks the creation privilege. Coverage includes 11 directional intraday families, shared swing entry/exit rules, malformed/future candles, partial fills, ambiguous acknowledgements, signed position recovery, risk limits, official-feed schemas, worker deadlines, authorization, authenticated HTTP flows and paired backup integrity. POSIX permission assertions still require Linux/macOS execution.
- `npm run test:browser`: all four desktop/mobile Chromium tests passed. They exercise actual local login, dashboard state, settings, research, short-position rendering and logout. Screenshots were visually inspected; mobile logout was repaired and managed positions were moved directly below account metrics.
- `npm run benchmark`: 9,000 synthetic symbol analyses, all valid, in 5.293 seconds; 188 concurrent analytics workers; 4.843 GiB peak process memory; zero broker requests. This is one synthetic workload on this machine, not an exchange latency or throughput guarantee.
- Public read-only checks validated all eight configured official index constituent files and both NSE corporate-event feeds. A verified corporate-action dummy is excluded with a visible count; non-EQ index constituents are classification records, not automatic trade eligibility.
- Windows capacity detection verified 96 physical/192 logical processors while Node reported 64. The wider Windows scheduling estimate is used only on supported builds without a detected primary-group restriction. Linux/macOS restricted-capacity behavior is covered by injected tests; those operating systems have not been run here.
- Production dependency audit reported zero known vulnerabilities. Changes remain uncommitted and no deployment folder was introduced.
- Separate agent reviews identified and verified fixes for delayed benchmark-context signals, superseded queued candidates, conflicting swing entry/exit rules, contradictory broker acknowledgements and publicly served data/backup paths. The regression suite covers these findings. Setup also creates private POSIX credential files, and backup rejects mismatched process-environment credentials. This review is not an external security certification.
- Follow-through recovery checks verify that unusable daily-history responses and prior-session seed caches recover through validated downloads and bounded retries instead of remaining stuck. Feed-worker failure and exhausted SDK reconnection restore the same subscription with bounded backoff; concurrent restart/close requests retain the latest generation and cannot exceed three live workers. Unconfirmed worker retirement prevents a replacement until exit is established.
- Two actual process-crash tests force-terminate a child during an accepted-but-unacknowledged synthetic BUY or SELL. The unclosed WAL journal retains the order reservation; the operating system releases the process lock; actual engine reconnection discovers ownership by tag; partial/full exit P&L remains idempotent across restarts. No external connections or real orders are used, and physical power loss is not simulated.
- Cross-platform CI is prepared in [node-checks.yml](../.github/workflows/node-checks.yml) for pull requests and manual runs: Node 24.9.0 on Ubuntu, Windows and macOS, locked dependency installation, unit/integration checks and Chromium desktop/mobile checks. Official actions are pinned to verified commit hashes, repository access is read-only, and checkout credentials and automatic package-manager caching are disabled. The workflow has not been executed; its presence is not evidence that these operating-system checks passed.

## External checks still required

The workspace has no local Kite credentials or authenticated session. Real account authentication, current entitlement/permission checks, full feed coverage, broker-side reconciliation and controlled live execution have not been verified. No real orders were placed. A read-only authenticated rehearsal is the next step; actual order verification requires a user-operated controlled test. Offline tests and public documents cannot justify claiming these checks passed or assigning a verified 10/10 score.

Cross-platform test execution, sustained market-session operation, network/power interruption behavior against the real broker, and independent security/operational review remain outside the evidence collected on this machine. These are non-profitability verification gaps, not demonstrated profitability requirements.

The local cross-platform environment was checked: Docker Desktop 4.27.2 is installed but its service/backend and both Docker WSL distributions are stopped, and neither configured Docker context has a running daemon. No Linux/macOS runtime test was claimed, and Docker configuration, services and existing workloads were left unchanged. The workspace still has no `.env`, application configuration or account journal available for authenticated broker verification.
