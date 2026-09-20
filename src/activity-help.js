/** Fixed troubleshooting instructions only. Never echo broker payloads or secrets. */
const page = (label, name, target) => ({label,page:name,...(target?{target}:{})});
const settings = (label, target) => page(label,'settings',target);
const background = page('Open Background','background');
const orders = page('Open Orders & trades','orders');
const developer = {label:'Kite Connect developer account',url:'https://developers.kite.trade/'};
const support = {label:'Zerodha support',url:'https://support.zerodha.com/'};
const help = (steps, links = []) => ({steps,links});
const decisionHelp = {
  maximum_positions: ['The bot position limit is reached. Review open positions in Overview and Settings → Maximum positions.','config-max_positions'],
  daily_trade_limit: ['The daily symbol-attempt limit is reached. Review Settings → Maximum new symbols attempted per day.','config-max_trades_per_day'],
  daily_loss_limit: ['Review today’s P&L in Overview and Settings → Daily loss limit (fraction). This risk stop pauses new entries.','config-daily_loss_pct'],
  invalid_capital_allocation: ['Open Settings → Trading strategies. Enabled strategies need a positive allocation and total allocation must not exceed 100%.','intraday-allocation'],
  insufficient_risk_or_cash_budget: ['Review available cash in Overview and Settings → Risk per trade (fraction) and Maximum allocation per stock (fraction).','config-risk_per_trade_pct'],
  aggregate_risk_limit: ['Open positions and pending entries use the available risk budget. Review Overview → Risk used and Settings → Daily loss limit (fraction).','config-daily_loss_pct'],
  existing_holdings_ignored: ['This stock is excluded by Settings → Existing holdings → Ignore stocks I already own.','holding-policy'],
  live_execution_disabled: ['Review Settings → Paper trading. Saving a mode change requires paused entries with managed live positions and pending orders resolved, then a server restart. Simulated positions are retained.','paper-trading'],
  strategy_disabled: ['This strategy is disabled in Settings → Trading strategies.','settings-form'],
  spread_too_wide: ['The bid/ask spread exceeds Settings → Maximum spread (fraction). The scanner waits for an eligible quote.','config-max_spread_pct'],
  turnover_too_low: ['Trading turnover is below Settings → Minimum daily turnover (₹).','config-min_daily_turnover'],
  entry_cutoff: ['The configured intraday entry window has ended. Review Settings → Intraday entry cutoff (IST).','config-entry_cutoff'],
  loss_cooldown: ['Review Overview → Decision controls for the cooldown end time and Settings → Loss cooldown (minutes).','config-loss_cooldown_minutes'],
};

export function activityHelp({kind='',level='',message='',data={}} = {}) {
  data = data && typeof data === 'object' ? data : {};
  const error = data.rejection || data, code = error.code || data.decision, exception = error.kind;
  if (['order_unknown','exit_unknown','ownership_conflict','protection_missing','exit_pending','delivery_blocked'].includes(kind))
    return help(['Open Kite → Orders and Positions and verify actual filled quantities and protective stop orders. In StockPilot, compare Orders & trades and Overview → Entry readiness.','Keep new entries paused while the order or protection is unresolved. Missing acknowledgement does not prove that an order failed.'],[orders,{label:'Open Kite',url:'https://kite.zerodha.com/'},support]);
  if (exception === 'TokenException' || kind === 'auth_expired' || code === 'session_expired')
    return help(['Select Start Trading to sign in to Zerodha again. Verify that you sign in with the client ID configured as KITE_USER_ID in the server’s .env file.','Check existing orders and positions in Kite while the app reconnects.'],[page('Open Overview','overview'),orders]);
  if ((exception === 'PermissionException' || ['ip_not_allowed','permission_denied'].includes(code)) && !['cover_unavailable','invalid_trigger','insufficient_margin'].includes(code)) {
    const history = /history|research/.test(String(error.operation || kind));
    return history
      ? help(['Open your app in the Kite Connect developer account and check historical market-data access and subscription status.','Open Background to see which download failed. HTTP 403 by itself does not identify the exact permission problem.'],[developer,background,support])
      : help(['Open Kite Connect developer account → Profile → IP Whitelist. Check that it contains the trading server’s static public outbound IP; a Cloudflare tunnel address is not that IP.','Check the API app’s trading permissions and account access. A rejection before an order ID is issued may not appear in Kite → Orders. If these checks pass, give Zerodha support the timestamp, exception type and HTTP status from this event.'],[developer,{label:'Static-IP setup instructions',url:'https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/static-ip'},support]);
  }
  if (error.http_status === 429 || exception === 'RateLimitException')
    return help(['Open Background → Broker requests are cooling down for the affected request category and retry time. Downloads resume after the cooldown.','Wait for the displayed retry time before starting research or reconnecting again.'],[background]);
  if (kind === 'system_clock')
    return level === 'info' ? null : help(['On Windows, open Settings → Time & language → Date & time, enable automatic time, then select Sync now. On another host, use its time-synchronization settings.','Return to Overview → Entry readiness and wait for a fresh broker clock check.'],[page('Open Entry readiness','overview')]);
  if (code === 'cover_unavailable' || code === 'invalid_trigger' || code === 'insufficient_margin' || kind === 'order_rejected' || kind === 'account_order' && level === 'error')
    return help([code === 'insufficient_margin' ? 'Check Kite → Funds for available cash and required margin.' : 'Check Kite → Orders → the affected order → rejection reason. For cover-order eligibility or trigger-price restrictions, use Zerodha support.', 'Open View event details for the symbol, order reference, exception type and HTTP status when available. API rejections without an order ID are visible only in StockPilot.'],[orders,support]);
  if (kind.startsWith('holdings.consent_') && ['warning','error'].includes(level) || kind === 'delivery' && /authori[sz]|consent|TPIN/i.test(message))
    return help(['Use the Zerodha holdings authorization banner → Authorize holdings, complete Zerodha/CDSL’s steps, then select Check authorization.','Review Settings → Existing holdings for the stocks the program is permitted to manage.'],[page('Open Holdings','holdings'),settings('Review holding permissions','holding-policy')]);
  if (kind === 'scan_summary') {
    const blocked = Object.entries(data).filter(([key,value])=>key.startsWith('decision:')&&value>0&&decisionHelp[key.slice(9)]).sort((a,b)=>b[1]-a[1]).slice(0,3);
    if (blocked.length) return help(blocked.map(([key])=>decisionHelp[key.slice(9)][0]),blocked.map(([key])=>settings(`Review ${key.slice(9).replaceAll('_',' ')}`,decisionHelp[key.slice(9)][1])));
    return null;
  }
  if (decisionHelp[code]) return help([decisionHelp[code][0]],[settings('Review relevant setting',decisionHelp[code][1])]);
  if (kind === 'risk_halt' && /daily loss limit/i.test(message)) return help([decisionHelp.daily_loss_limit[0]],[settings('Review daily loss limit','config-daily_loss_pct')]);
  if (kind === 'analytics_error') return help(['Open Background → Live analytics to inspect workers and queued jobs.','Review Settings → Analytics workers (0 = automatic), CPU reserve and Analysis batch size. Pause entries and resolve managed live positions and pending orders before saving, then restart the server. Simulated positions are retained.'],[background,settings('Review analytics settings','config-analytics_workers')]);
  if (exception === 'NetworkException' || Number(error.http_status) >= 500)
    return help(['Check the trading server’s internet connection and Zerodha service availability. Open Background for the affected operation and retry status.','For order submission or exit failures, check Kite → Orders and Positions before attempting another order.'],[background,orders,support]);
  if (kind === 'session.wrong_account' || kind === 'connection_error' || kind === 'session.start_failed' || kind === 'session.restore_failed')
    return help(['Check KITE_API_KEY, KITE_API_SECRET and KITE_USER_ID in the server’s .env file. Restart StockPilot after editing them, then select Start Trading.','Open Settings → Zerodha app URLs and compare Redirect URL and Postback URL with your Kite Connect app.'],[settings('Open Zerodha app URLs','broker-url-redirect'),developer]);
  if (kind.endsWith('history_error')) return help(['Open Background → Daily candle history or Five-minute candle history for download status and retry time.','Check historical-data access in the Kite Connect developer account. A partial download does not make a stock ready to trade.'],[background,developer]);
  if (kind.startsWith('research.') && ['warning','error'].includes(level)) return help(['Open Research for the failed stage, error details and retry time.','Review the research sample size, candidate count and time limit in Settings if the reported failure concerns workload or timeout.'],[page('Open Research','research'),settings('Review research settings','config-research_symbols')]);
  if (['warning','error'].includes(level)) return help(['Open Background and Overview → Entry readiness to identify the affected operation. Expand View event details for diagnostic codes.','If the issue continues, export activity history and provide the event timestamp, type and diagnostic codes when seeking support.'],[background,page('Open Entry readiness','overview')]);
  return null;
}
