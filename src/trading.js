/** Persistent NSE scanner and serialized, journalled paper/live execution.
 * An ambiguous broker mutation is never automatically retried. Recovery verifies
 * actual broker exposure before admitting new decisions from fresh candles.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KiteBroker, BrokerError, jsonable, orderRejectionReason, HISTORICAL_CONCURRENCY } from './broker.js';
import { AnalyticsPool } from './analytics.js';
import { DeliveryManager } from './delivery.js';
import { HoldingsAuthorization } from './holdings-authorization.js';
import { Candle, CandleBook, Signal, position_size, STRATEGY_VERSION, technical_exit, daily_holding_exit, swing_entry_gate } from './strategy.js';
import { marketBreadth, portfolioExposure, portfolioEntryGate, returnCorrelation, pendingDeliveryQuantity } from './decision-controls.js';
import { sideOf, directionOf, exitSideOf, plannedRisk, markedProfit } from './direction.js';
import { MarketContext } from './market-context.js';
import { EquityUniverse } from './equity-universe.js';
import { BackgroundActivity } from './background-activity.js';
import { activityHelp } from './activity-help.js';
import { validate_bars } from './indicators.js';
import { Mutex, sleep, monotonic, nowIST, parseTime, dateIST, timeIST, isoIST, marketHours } from './util.js';

const TERMINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const FEE_RATE = 0.001; // Conservative simulation allowance; not a fee/tax quotation.
const values = Object.values;
const entries = Object.entries;
const count = value => Object.keys(value).length;
const sum = list => list.reduce((a, b) => a + b, 0);
const round = (value, digits = 2) => Number(value.toFixed(digits));
const keyFor = (strategy, token) => `${strategy}:${token}`;
const bidOf = quote => Number(quote?.depth?.buy?.[0]?.price || 0);
const askOf = quote => Number(quote?.depth?.sell?.[0]?.price || 0);
const unresolved = new Set(['submitting', 'unknown', 'conflict', 'unprotected', 'exit_unknown', 'exit_pending']);
const FAILURE_KINDS = new Set(['TokenException', 'PermissionException', 'InputException', 'OrderException', 'NetworkException', 'DataException', 'GeneralException', 'BrokerException', 'Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'AbortError', 'TimeoutError']);
function validBrokerFill(order) {
  const explicitNumber=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
  const quantity=Number(order.quantity),filled=Number(order.filled_quantity);
  return explicitNumber(order.quantity)&&Number.isSafeInteger(quantity)&&quantity>0&&
    explicitNumber(order.filled_quantity)&&Number.isSafeInteger(filled)&&filled>=0&&filled<=quantity&&
    (order.status!=='COMPLETE'||filled===quantity)&&
    (!filled||explicitNumber(order.average_price)&&Number(order.average_price)>0);
}
function failureMetadata(error, operation, stage) {
  const broker = error instanceof BrokerError, candidate = broker ? error.kind : error?.name;
  return { operation, stage, kind: FAILURE_KINDS.has(candidate) ? candidate : broker ? 'BrokerException' : 'Error',
    http_status: broker && Number.isInteger(error.http_status) && error.http_status >= 100 && error.http_status <= 599 ? error.http_status : null };
}

export class TradingEngine {
  constructor(settings, store, options = {}) {
    this.settings = settings; this.store = store;
    this._now = options.now || options.clock?.now?.bind(options.clock) || nowIST;
    this._brokerFactory = options.brokerFactory || ((key, token) => new KiteBroker(key, token));
    this._backgroundLoops = options.backgroundLoops !== false;
    this.mode = settings.trading_mode;
    this.state_key = `bot_state_${this.mode}`;
    const saved = store.get(this.state_key, {});
    this.capital = Number.isFinite(Number(saved.capital)) && Number(saved.capital) > 0 ? Number(saved.capital) : 0;
    this._capital_accounted_pnl = Number(saved.capital_accounted_pnl || 0);
    this._paper_capital_seeded = this.mode === 'paper' && this.capital > 0;
    this._broker_available_cash = 0;
    this.positions = saved.positions || {}; this.intents = saved.intents || {};
    this.realised = Number(saved.realised || 0); this.day = saved.day || dateIST(this._now());
    this.day_baseline = Number(saved.day_baseline ?? this.realised);
    this.day_open_unrealised = Number(saved.day_open_unrealised || 0);
    this.traded = new Set(saved.traded || []); this.user_id = saved.user_id || '';
    this.connected = false; this.running = false; this.status = 'disconnected';
    this.message = 'Connect Zerodha to start the market feed and account monitoring.'; this.error = null;
    this.broker = null;
    this.delivery = this.mode === 'live' ? (options.deliveryFactory ? options.deliveryFactory(store, null, settings, this._now) : new DeliveryManager(store, null, settings, this._now)) : null;
    this.holdings_authorization = new HoldingsAuthorization(store,()=>this._now());
    this._profile = null;
    if (this.delivery) {
      this.delivery.strategy_settings = () => this.strategy_settings();
      this.delivery.authorization_needed = request => this.holdings_authorization.require(request);
      this.delivery.authorization_blocked = symbol => this.holdings_authorization.isBlocked(symbol);
    }
    this._delivery_accounted = Number(saved.delivery_accounted || 0);
    this.universe = {}; this.books = {}; this.quotes = {}; this.streams = {};
    this.equity_universe = options.equityUniverse || new EquityUniverse(store,{now:()=>this._now()});
    this.universe_summary=null;this._universe_date='';this._universe_generation=0;this._universe_retry_at=0;this._instrument_master=null;this._instrument_master_date='';
    this.account = store.get('account_snapshot', { margins: {}, holdings: [], positions: {}, orders: [], trades: [] });
    this._account_at = -Infinity; this._heartbeat = null; this._tasks = []; this._retiringTasks = [];
    this._lock = new Mutex(); this._candidates = []; this.signals = []; this._stats = {};
    this._last_summary = 0; this._last_persist = 0; this._reconcile_requested = false;
    this._wakeMonitor = null; this._controller = null;
    this._order_seen = {}; this._trade_seen = new Set(); this._position_seen = null;
    this._holdings_seen = null; this._balance_seen = null; this._balance_logged_at = 0;
    this.daily = {}; this._daily_checked = new Set(); this._history_date = ''; this._history_failures = 0; this._daily_history_retry = {};
    this._shutdown = false; this._last_tick_received = -Infinity; this._risk_halted = false;
    this.holdings_signals = []; this._paper_holding_actions = store.get('paper_holding_actions', {});
    this._last_holdings_scan = 0; this._intraday_history_loaded = new Set(); this._intraday_history_failed = 0; this._intraday_history_retry={};
    this._intraday_warmup = null;
    this._history_logged = {};
    this.analytics = options.analyticsFactory ? options.analyticsFactory(settings) : new AnalyticsPool(settings.analytics_workers || 0, settings.analytics_reserve_cpus ?? 4, settings.analytics_batch_size || 32);
    this._analysis_pending = new Map(); this._analysis_tasks = new Set(); this._analysis_cache = new Map(); this._analysis_generation = 0;
    this._analysis_requested = new Map(); this._analysis_sequence = 0;
    this._activity = new BackgroundActivity(() => this._now());
    this._active_batches = new Map();
    this._last_analysis_error = null;
    this._last_analysis_at = null;
    this._batch_sequence = 0;
    this._correlation_wanted = new Set(); this._candidate_batch_at = null;
    this.previous_intraday={};
    this.market_context=options.marketContextFactory?options.marketContextFactory(store,settings):new MarketContext(store,settings,{now:()=>this._now()});
    this._loss_control = saved.loss_control || {day:this.day,last_realised:this.realised,loss_events:0,until:null};
    this._profile_verified = false; this._recovery_account_verified = false; this._recovery_holdings_checked = false; this._clock_seen = null;
    this.recovery = { phase: 'awaiting_session', message: 'Sign in to Zerodha to verify the current account before trading.', started_at: null, completed_at: null, blocked: true };
  }

  strategy_settings() {
    const config = this.store.get('strategy_settings', { intraday_enabled: true, swing_enabled: false, intraday_allocation_pct: 1, swing_allocation_pct: 0 });
    // Preserve allocation proportions when opening a previous Python journal.
    // The former manually selected capital is no longer a funding source.
    if (config.intraday_allocation_pct === undefined || config.swing_allocation_pct === undefined) {
      const intraday = Number(config.intraday_capital || 0), swing = Number(config.swing_capital || 0), allocated = intraday + swing;
      config.intraday_allocation_pct ??= allocated > 0 ? intraday / allocated : 1;
      config.swing_allocation_pct ??= allocated > 0 ? swing / allocated : 0;
      delete config.intraday_capital; delete config.swing_capital;
      this.store.set('strategy_settings', config);
    }
    return { ...config, intraday_capital: this.capital * Number(config.intraday_allocation_pct), swing_capital: this.capital * Number(config.swing_allocation_pct) };
  }
  _event(kind, message, data = null, level = 'info') { return this.store.event(kind, message, jsonable(data), level); }
  _persist() {
    this.store.set(this.state_key, jsonable({ positions: this.positions, intents: this.intents, realised: this.realised, day: this.day,
      day_baseline: this.day_baseline, day_open_unrealised: this.day_open_unrealised, traded: [...this.traded].sort(), user_id: this.user_id, delivery_accounted: this._delivery_accounted,
      capital: this.capital, capital_accounted_pnl: this._capital_accounted_pnl, loss_control:this._loss_control }));
  }
  _halt(message, kind = 'risk_halt', data = null) {
    if (this.error !== message) this._event(kind, message, data, 'error');
    this.running = false; this.status = 'error'; this.error = this.message = message;
    this.error_help = activityHelp({kind,message,data,level:'error'});
    if (this._unresolved_intents()) Object.assign(this.recovery, { phase: 'blocked', message, blocked: true, completed_at: null });
  }
  _maintenance() { return existsSync(join(this.settings.data_dir, 'maintenance.lock')); }
  _other_mode_live_risk() {
    if (this.mode === 'live') return false;
    const saved = this.store.get('bot_state_live', {}), delivery = this.store.get('delivery_state', {});
    return Boolean(count(saved.positions || {}) || values(saved.intents || {}).some(i => !['closed', 'rejected'].includes(i.state)) || values(delivery.positions || {}).some(p => p.status !== 'closed'));
  }
  _invalidate_decisions() {
    this._analysis_generation++; this._analysis_pending.clear(); this._analysis_requested.clear(); this._analysis_cache.clear(); this._daily_checked.clear(); this._candidates = [];
    this._candidate_batch_at = null;
  }
  _begin_recovery() {
    this._invalidate_decisions(); this._recovery_account_verified = false; this._recovery_holdings_checked = false; this._last_holdings_scan = 0;
    this.recovery = { phase: 'reconciling', message: 'Verifying current balances, holdings, positions, orders and protection with Zerodha.', started_at: isoIST(this._now()), completed_at: null, blocked: true };
  }
  _managed_recovery_symbols() {
    const symbols = Object.fromEntries(entries(this.positions).map(([s, p]) => [s, p.strategy === 'swing']));
    if (this.delivery) for (const [symbol, p] of entries(this.delivery.snapshot().positions || {})) if (p.status !== 'closed') symbols[symbol] = true;
    if (this.running) for (const holding of this._authorized_holdings()) symbols[holding.tradingsymbol] = true;
    return symbols;
  }
  _selected_holdings() {
    const config = this.strategy_settings(), selected = new Set(config.managed_symbols || []);
    if (config.manage_existing_holdings === 'ignore') return [];
    return (this.account.holdings || []).filter(h => h.exchange === 'NSE' && (h.product || 'CNC') === 'CNC' && !h.discrepancy && Number(h.quantity || 0) - Number(h.used_quantity || 0) - Number(h.collateral_quantity || 0) > 0 && (config.manage_existing_holdings === 'all' || selected.has(h.tradingsymbol)));
  }
  _authorized_holdings() {
    const eligible=new Set(values(this.universe).filter(i=>i.entry_eligible!==false).map(i=>i.tradingsymbol));
    return this._selected_holdings().filter(h=>eligible.has(h.tradingsymbol));
  }
  _holding_management_settings(){
    const config=this.strategy_settings(),selected=new Set(config.managed_symbols||[]),symbols=new Set(this._authorized_holdings().map(h=>h.tradingsymbol));
    if (config.manage_existing_holdings === 'ignore') return {...config,managed_symbols:[]};
    for(const [symbol,p] of entries(this.delivery?.snapshot().positions||{}))if(p.status!=='closed'&&(config.manage_existing_holdings==='all'||selected.has(symbol)))symbols.add(symbol);
    return {...config,manage_existing_holdings:'selected',managed_symbols:[...symbols]};
  }
  async _refresh_universe_locked(instruments=null,onStage=null){
    const activity=this._activity.begin('universe',{message:'Downloading NSE instruments.',total:3});
    try {
    const today=dateIST(this._now());
    this._universe_retry_at=monotonic()+60;
    const master=instruments||(this._instrument_master_date===today&&this._instrument_master?this._instrument_master:await this.broker.call('instruments','NSE'));
    activity({message:'Verifying official NSE stock and ETF lists.',completed:1});
    const managedSymbols=[...new Set([...Object.keys(this.positions),...values(this.intents).filter(i=>!['closed','rejected'].includes(i.state)).map(i=>i.symbol),...entries(this.delivery?.snapshot().positions||{}).filter(([,p])=>p.status!=='closed').map(([symbol])=>symbol)])];
    const result=await this.equity_universe.resolve(master,{managedSymbols});
    if(result.instruments.length>9000)throw new Error('Verified NSE shares plus managed exposure exceed the streaming capacity. No symbols were silently removed.');
    const before=this.universe,next=Object.fromEntries(result.instruments.map(i=>[Number(i.instrument_token),i]));
    this._instrument_master=master;this._instrument_master_date=today;this.universe=next;this.universe_summary=result.summary;
    const generation=++this._universe_generation;
    // Classification alone cannot complete refresh: an unsuccessful stream
    // replacement must remain eligible for the monitor's bounded retry.
    this._universe_date='';
    this._invalidate_decisions();
    Object.assign(this.recovery,{phase:'reconciling',blocked:true,completed_at:null});this._recovery_holdings_checked=false;
    this.books=Object.fromEntries(entries(next).map(([token,instrument])=>[token,before[token]?.tradingsymbol===instrument.tradingsymbol&&this.books[token]||new CandleBook()]));
    this.daily=Object.fromEntries(entries(this.daily).filter(([token])=>next[token]&&before[token]?.tradingsymbol===next[token].tradingsymbol));
    this.previous_intraday=Object.fromEntries(entries(this.previous_intraday).filter(([token])=>next[token]&&before[token]?.tradingsymbol===next[token].tradingsymbol));
    this._daily_history_retry={};this._correlation_wanted.clear();
    const tokens=Object.fromEntries(entries(next).map(([token,i])=>[i.tradingsymbol,Number(token)]));
    for(const [symbol,position] of entries(this.positions))position.token=tokens[symbol]||0;
    for(const intent of values(this.intents))intent.token=tokens[intent.symbol]||0;
    this.delivery?.remap_tokens(tokens);
    this.quotes={};this.streams={};this._last_tick_received=-Infinity;this._heartbeat=null;
    this._intraday_history_loaded.clear();this._intraday_history_retry={};this._history_date='';
    this._reconcile_authorization();
    this._event('universe_classified',result.summary.status==='verified'?'NSE stock and ETF universe verified against official security lists.':'NSE security lists unavailable. New entries are blocked; managed exposure remains monitored.',result.summary,result.summary.status==='verified'?'info':'warning');
    const activeBroker=this.broker;
    const current=()=>this.broker===activeBroker&&generation===this._universe_generation&&!this._shutdown;
    onStage?.('stream');
    activity({message:`Subscribing to ${Object.keys(next).length} NSE instruments.`,completed:2});
    await activeBroker.stream(Object.keys(next).map(Number),ticks=>{if(current())this._on_ticks(ticks);},order=>{if(current())this._on_order(order);},(...args)=>{if(current())this._on_stream(...args);});
    if(current()&&dateIST(this._now())===today)this._universe_date=result.summary.status==='verified'?today:'';
    activity({status:result.summary.status==='verified'?'idle':'waiting',message:result.summary.status==='verified'?`${Object.keys(next).length} NSE instruments classified; feed subscriptions requested.`:'Official NSE lists unavailable. Entries wait for verification.',completed:3});
    } catch (error) { activity({status:'failed',message:'NSE universe refresh failed. Reconnect if startup failed; connected monitoring retries refreshes.',failed:1});throw error; }
  }
  _has_managed_or_authorized_exposure() {
    return count(this.positions) > 0 || this._authorized_holdings().length > 0 || values(this.delivery?.snapshot().positions || {}).some(p => p.status !== 'closed');
  }
  _advance_recovery() {
    if (this.recovery.phase === 'ready') return;
    let reason = '', phase = 'warming_up';
    if (!this.connected) { reason = 'Sign in to Zerodha to restore verified account monitoring.'; phase = 'awaiting_session'; }
    else if (!this._profile_verified || !this._recovery_account_verified) { reason = 'Waiting for complete broker account verification.'; phase = 'reconciling'; }
    else if (this._unresolved_intents()) { reason = 'An order, quantity or protection is unresolved. Inspect Zerodha; no duplicate orders will be sent.'; phase = 'blocked'; }
    else if (this.universe_summary&&(this.universe_summary.status!=='verified'||this._universe_date!==dateIST(this._now()))) { reason='NSE stock and ETF lists are unavailable or stale. New entries wait while account and managed-position monitoring continue.';phase='blocked'; }
    else if (this.mode==='live'&&this.holdings_authorization.snapshot().required) { reason='Complete the required holdings authorization on Zerodha/CDSL. Existing positions remain monitored.';phase='awaiting_authorization'; }
    else {
      const symbols = this._managed_recovery_symbols(), tokens = Object.fromEntries(entries(this.universe).map(([t, i]) => [i.tradingsymbol, Number(t)]));
      const stale = Object.keys(symbols).filter(s => !(s in tokens) || monotonic() - (this.quotes[tokens[s]]?.received_at ?? -Infinity) > 10);
      const daily = entries(symbols).filter(([s, needed]) => needed && (this.daily[tokens[s]] || []).length < 21).map(([s]) => s);
      if (stale.length) reason = `Waiting for fresh market prices for managed shares: ${stale.slice(0, 5).join(', ')}.`;
      else if (daily.length) reason = `Loading current completed daily candles for managed shares: ${daily.slice(0, 5).join(', ')}.`;
      else if (values(symbols).some(Boolean) && !this._recovery_holdings_checked) reason = 'Re-evaluating managed holdings and their exit conditions before new buys.';
    }
    if (reason) Object.assign(this.recovery, { phase, message: reason, blocked: true });
    else {
      Object.assign(this.recovery, { phase: 'ready', message: 'Current account and managed exposure verified. New decisions require fresh quotes and eligible completed candles.', completed_at: isoIST(this._now()), blocked: false });
      this._event('recovery_ready', this.recovery.message); this._invalidate_decisions();
      for (const token of Object.keys(this.universe)) if (monotonic() - (this.quotes[token]?.received_at ?? -Infinity) <= 10) this._queue_current_analysis(Number(token));
    }
  }

  async connect(access_token, user_id, {onProgress} = {}) {
    return this._lock.run(async () => {
      if (this.user_id && this.user_id !== user_id) throw new Error('This data directory belongs to a different Zerodha account.');
      if (this.settings.kite_user_id && this.settings.kite_user_id !== user_id) throw new Error('The Zerodha account does not match KITE_USER_ID.');
      await this._stop_tasks();
      this.running = false; this.connected = false; this._profile_verified = false; this._account_at = -Infinity;
      this._begin_recovery(); this._roll_day(); this.daily = {}; this._history_date = ''; this._daily_history_retry = {}; this.books = {}; this.quotes = {}; this.streams = {};
      this._last_tick_received = -Infinity; this._heartbeat = null;
      if (this.broker) await this.broker.close();
      this.broker = this._brokerFactory(this.settings.kite_api_key, access_token);
      if (this.delivery) this.delivery.broker = this.broker;
      this.user_id = user_id; this.running = false; this._shutdown = false;
      let stage = 'profile';
      try {
        onProgress?.({phase:'profile',message:'Verifying your Zerodha account.',completed:0,total:10});
        const profile = await this.broker.call('profile');
        if (String(profile.user_id || '').toUpperCase() !== String(user_id).toUpperCase()) throw new Error('Broker profile belongs to another account');
        this._profile = profile;this._profile_verified = true; stage = 'account';
        onProgress?.({phase:'account',message:'Downloading your Zerodha account.',completed:1,total:10});
        await this._refresh_account_locked({ rebase_capital: true, onProgress:progress=>onProgress?.({...progress,completed:1+progress.completed,total:10}) });
        stage = 'universe';
        onProgress?.({phase:'instruments',message:'Downloading the NSE instrument list.',completed:7,total:10});
        const universeActivity=this._activity.begin('universe',{message:'Downloading the NSE instrument list.',total:3});
        let instruments;
        try {instruments=await this.broker.call('instruments','NSE');}
        catch(error){universeActivity({status:'failed',message:'NSE instrument download failed. Reconnect to retry startup.',failed:1});throw error;}
        this.connected = true;
        onProgress?.({phase:'universe',message:'Verifying NSE stock and ETF lists.',completed:8,total:10});
        await this._refresh_universe_locked(instruments, value => { stage = value; onProgress?.({phase:value,message:'Subscribing to the live NSE market feed.',completed:9,total:10}); });
        stage = 'readiness';
        if (!this._unresolved_intents()) { this.status = 'monitoring'; this.error = null; this.message = 'Monitoring Zerodha. Entries wait for completed strategy candles, prior-session context and fresh risk checks.'; }
        this._advance_recovery();
        if (this._backgroundLoops) this._start_tasks();
        this._event('connected', 'Zerodha account connected; entries remain paused.', { user_id, universe_count: count(this.universe), mode: this.mode });
        this._event('analytics_capacity', 'Parallel analytics ready; order execution remains serial.', this.analytics.snapshot()); this._persist();
        onProgress?.({phase:'connected',message:'Account connected. Background candle loading and monitoring are active.',completed:10,total:10});
      } catch (exc) {
        const failure = failureMetadata(exc, 'connect', stage);
        this.connected = false; this._halt(`Connection setup failed (${failure.kind}). Verify Kite API access and reconnect.`, 'connection_error', failure);
        Object.assign(this.recovery, { phase: 'blocked', message: this.message, blocked: true });
        if (this.broker) await this.broker.close();
        throw new Error(this.message);
      }
    });
  }

  async start({onProgress,isCancelled=()=>false} = {}) {
    return this._lock.run(async () => {
      if (isCancelled()) return;
      if (this._maintenance()) throw new Error('Maintenance is active; trading cannot start.');
      if (this._other_mode_live_risk()) throw new Error('Unresolved real-money exposure exists from live mode. Restore live configuration and reconcile before using paper mode.');
      if (!this.connected || !this.broker) throw new Error('Connect Zerodha before starting trading.');
      const config = this.strategy_settings();
      if (!config.intraday_enabled && !config.swing_enabled) throw new Error('Enable at least one strategy in Settings.');
      const allocations = ['intraday', 'swing'].map(s => Number(config[`${s}_allocation_pct`] ?? 0));
      if (allocations.some(c => !Number.isFinite(c) || c < 0) || sum(allocations) > 1.0000001) throw new Error('Saved strategy allocations exceed available capital. Update Settings before starting.');
      if (['intraday', 'swing'].some(s => config[`${s}_enabled`] && Number(config[`${s}_allocation_pct`] || 0) <= 0)) throw new Error('Every enabled strategy needs a positive allocation.');
      if (this.mode === 'live' && !this.settings.live_trading_enabled) throw new Error('Live trading must be enabled in Settings.');
      onProgress?.({phase:'account',message:'Refreshing account balances and reconciling existing positions.',completed:0,total:2});
      this.running = false; this._begin_recovery(); this._roll_day(); await this._refresh_account_locked({ rebase_capital: true, onProgress:progress=>onProgress?.({...progress,completed:0,total:2}) });
      if (isCancelled()) return;
      onProgress?.({phase:'risk',message:'Checking recovery, strategy allocation and risk limits.',completed:1,total:2});
      if (this._unresolved_intents()) { this._advance_recovery(); throw new Error('An order or exit is unresolved. Reconcile it in Zerodha before restarting.'); }
      if (this.capital > 0 && this._daily_pnl() <= -this.capital * this.settings.daily_loss_pct) throw new Error('The daily loss limit has been reached.');
      if (this._maintenance()) throw new Error('Maintenance began during account reconciliation; trading remains paused.');
      if (isCancelled()) return;
      this.running = true; this.status = 'running'; this.error = null;
      this._update_running_message();
      this._event('trading_started', 'Trading enabled.', { mode: this.mode, strategies: this.strategy_settings() }); this._advance_recovery();
      for (const token of Object.keys(this.universe)) if (monotonic() - (this.quotes[token]?.received_at ?? -Infinity) <= 10) this._queue_current_analysis(Number(token));
      onProgress?.({phase:'armed',message:'Startup finished. Strategies wait for eligible data and all entry checks.',completed:2,total:2});
    });
  }
  _waiting_for_funds() {
    return this.running && (this.capital <= 0 || (this.mode === 'live' && this._available_cash() <= 0));
  }
  _update_running_message() {
    if (!this.running) return;
    this.message = !this._waiting_for_funds()
      ? 'Strategies armed. Entries wait for market hours, fresh data and all risk checks.'
      : this._has_managed_or_authorized_exposure()
        ? 'Holding management armed. New buys remain blocked until verified trading cash is available.'
        : 'Strategies armed, waiting for verified trading cash. Add funds in Zerodha; entries can begin after account refresh, fresh market data and all risk checks.';
  }
  async pause() {
    this.running = false; this._invalidate_decisions();
    return this._lock.run(async () => {
      this.running = false; this.status = this.connected ? 'paused' : 'disconnected';
      this.message = 'New entries paused. Existing positions and account monitoring remain active.';
      if (this.mode === 'live' && this.broker && this.connected) { await this._cancel_pending_entries_locked(); await this.delivery.cancel_pending_entries(); this._sync_delivery(); }
      this._event('trading_paused', this.message); this._persist();
    });
  }
  _authorization_scope() {
    // A directory outage is not a withdrawal of previously selected consent.
    const scope=new Set(this._selected_holdings().map(h=>h.tradingsymbol));
    for(const [symbol,p] of Object.entries(this.delivery?.snapshot().positions||{}))if(p.status!=='closed')scope.add(symbol);
    return scope;
  }
  _reconcile_authorization(profile=this._profile,{userConfirmed=false}={}) {
    const before=this.holdings_authorization.snapshot().required;
    const result=this.holdings_authorization.reconcile(this.account.holdings||[],profile,this._authorization_scope(),{userConfirmed});
    if(before&&!result.required){
      // Human authorization permits a fresh evaluation, never a replay of the
      // former signal, limit price or quantity from before the user step.
      this._last_holdings_scan=0;this._recovery_holdings_checked=false;this._invalidate_decisions();
    }
    return result;
  }
  async start_holdings_authorization() {
    return this._lock.run(async()=>{
      if(this._shutdown||!this.connected||!this.broker)throw new Error('Connect Zerodha before authorizing holdings');
      if(this.mode!=='live')throw new Error('Paper trading does not require real holdings authorization');
      await this._refresh_account_locked({reconcile_positions:false});
      return this.holdings_authorization.start(this.broker,this.settings.kite_api_key,this.account.holdings||[]);
    });
  }
  async refresh_holdings_authorization(userConfirmed=false) {
    return this._lock.run(async()=>{
      if(this._shutdown||!this.connected||!this.broker)throw new Error('Connect Zerodha before checking holdings authorization');
      await this._refresh_account_locked({authorization_user_confirmed:userConfirmed,reconcile_positions:false});this.request_reconciliation();
      return this.holdings_authorization.snapshot();
    });
  }
  async flatten() {
    this.running = false; this._invalidate_decisions();
    return this._lock.run(async () => {
      this.running = false; this.status = 'paused';
      if (!this.connected) throw new Error('Reconnect Zerodha before requesting exits.');
      if (this.mode === 'live') { await this._refresh_account_locked(); await this._cancel_pending_entries_locked(); await this.delivery.cancel_pending_entries(); this._sync_delivery(); }
      const managed = this.delivery ? values(this.delivery.snapshot().positions || {}).filter(p => p.source === 'existing' && p.status !== 'closed' && p.remaining_quantity > 0) : [];
      if ((count(this.positions) || managed.length) && !marketHours(this._now())) {
        this._event('flatten_blocked', 'Managed exits require an open market session; broker protection remains in place.', null, 'warning');
        throw new Error('The regular market session is closed. Managed exits need an open session; existing broker protection remains in place.');
      }
      for (const symbol of Object.keys(this.positions)) await this._exit_locked(symbol, 'operator_flatten');
      const missing = [];
      for (const position of managed) {
        const symbol = position.symbol, quote = this.quotes[Number(position.token || 0)] || {}; let bid = bidOf(quote);
        if (monotonic() - (quote.received_at ?? -Infinity) > 10 || bid <= 0) {
          const raw = (await this.broker.call('quote', [`NSE:${symbol}`]))[`NSE:${symbol}`] || {}, at = parseTime(raw.timestamp); bid = bidOf(raw);
          if (!at || Math.abs(this._now() - at) > 10000 || bid <= 0) { missing.push(symbol); continue; }
        }
        const result = await this.delivery.request_exit(symbol, position.remaining_quantity, bid, 'Operator close managed holdings');
        this._event('managed_holding_exit_requested', `Exit requested for previously adopted ${symbol} holding.`, { symbol, quantity: position.remaining_quantity, result }); this._sync_delivery();
      }
      this._event('flatten_requested', 'Exit requested for bot positions and already-managed holdings. Confirm fills in the account view.'); this._persist();
      if (missing.length) throw new Error(`Fresh executable quotes are unavailable for: ${missing.join(', ')}. Other managed exit requests were processed; inspect the account view.`);
    });
  }
  _start_tasks() {
    this._controller = new AbortController();
    const signal = this._controller.signal;
    this._tasks = ['_run', '_monitor', '_history', '_intraday_history', '_analysis_loop', '_market_context_loop'].map(method => this[method](signal).catch(error => {
      const failure = failureMetadata(error, 'background_task', method);
      if (!signal.aborted && !this._shutdown) this._halt(`Background task failed (${failure.kind}); entries paused.`, 'engine_error', failure);
    }));
  }
  async _stop_tasks() {
    this._controller?.abort(); this._wakeMonitor?.(); this._wakeMonitor = null;
    this._activity.stop();
    this._invalidate_decisions();
    // A caller can own the execution mutex. Waiting here on another task queued
    // for that mutex would deadlock; tasks check cancellation after acquiring it.
    const retired = this._tasks; this._tasks = [];
    this._retiringTasks.push(...retired);
    Promise.allSettled(retired).then(() => { this._retiringTasks = this._retiringTasks.filter(t => !retired.includes(t)); });
  }
  async shutdown() {
    this._shutdown = true; await this._stop_tasks();
    try { await this.pause(); }
    finally {
      if (this.broker) await this.broker.close();
      await this.market_context.close();
      await this.analytics.close();
      await Promise.allSettled([...this._retiringTasks, ...this._analysis_tasks]);
      this.connected = false; this._persist();
    }
  }
  _on_stream(index, connected, tokens) {
    if (this._shutdown) return;
    const previous = this.streams[index]; this.streams[index] = connected;
    if (previous !== connected) this._event(connected ? 'feed_connected' : 'feed_disconnected', `Market feed ${index + 1} ${connected ? 'connected.' : 'disconnected; entries require fresh data.'}`);
    if (!connected) {
      this._invalidate_decisions(); this._recovery_holdings_checked = false;
      Object.assign(this.recovery, { phase: 'warming_up', message: 'Market stream interrupted; managed exposure needs fresh prices before new buys.', blocked: true, completed_at: null });
      for (const token of tokens) { this._intraday_history_loaded.delete(Number(token)); this.books[token] = new CandleBook(); delete this.quotes[token]; }
    }
  }
  _on_order(order) { if (!this._shutdown) { this._record_order(order); this.request_reconciliation(); } }
  request_reconciliation() { if (!this._shutdown) { this._reconcile_requested = true; this._wakeMonitor?.(); } }
  _record_order(order) {
    const oid = String(order.order_id || ''), signature = JSON.stringify(['status', 'filled_quantity', 'pending_quantity', 'price', 'trigger_price', 'quantity', 'average_price'].map(k => order[k]));
    if (oid && this._order_seen[oid] !== signature) {
      this._order_seen[oid] = signature;
      this._event('account_order', `${order.tradingsymbol || ''}: ${order.transaction_type || ''} ${order.status || ''}`, order, order.status === 'REJECTED' ? 'error' : 'info');
    }
  }
  _on_ticks(ticks) {
    if (this._shutdown) return;
    // A known clock mismatch can make genuinely old exchange data look current.
    // Keep the normal timestamp checks; do not shift prices onto the host clock.
    if (this.broker?.clock_health?.().blocked) return;
    const now = this._now(); if (!marketHours(now)) return;
    const arrived = monotonic();
    for (let tick of ticks) {
      const token = Number(tick.instrument_token || 0); if (!(token in this.universe)) continue;
      const at = parseTime(tick.exchange_timestamp), price = Number(tick.last_price || 0),volume=Number(tick.volume_traded);
      if (!at || Math.abs(now - at) > 10000 || !Number.isFinite(price) || price <= 0||!Number.isFinite(volume)||volume<0) continue;
      const previousAt=parseTime(this.quotes[token]?.exchange_timestamp),bookAt=this.books[token]?.last_time;
      if(previousAt&&at<previousAt||bookAt&&at<bookAt)continue;
      // Reject same-session volume rollbacks before publishing quotes/turnover,
      // position marks or freshness. The retained book also protects reconnects
      // where the quote cache is empty; a new date permits the volume reset.
      if(previousAt&&dateIST(at)===dateIST(previousAt)&&volume<Number(this.quotes[token].volume_traded)||
        bookAt&&dateIST(at)===dateIST(bookAt)&&volume<this.books[token].last_volume)continue;
      // received_at is the conservative monotonic freshness origin shared by
      // entries, exits, breadth and readiness. Account for exchange age already
      // spent in transit; receipt never grants an old tick another ten seconds.
      // Future timestamps within the existing tolerance get no extra lifetime.
      const freshAt=arrived-Math.max(0,now-at)/1000;
      tick = { ...tick, received_at: freshAt }; this.quotes[token] = tick; this._last_tick_received = Math.max(this._last_tick_received,freshAt); this._heartbeat = isoIST(now);
      const symbol = this.universe[token].tradingsymbol; if (this.positions[symbol]) this.positions[symbol].last = price;
      const previous = this.books[token].bars.length, closed = this.books[token].update(at, price, Number(tick.volume_traded || 0));
      if (previous && !this.books[token].bars.length) this._intraday_history_loaded.delete(token);
      if (closed) this._queue_analysis(token, 'intraday', this.books[token].bars);
      if (this.daily[token] && !this._daily_checked.has(token)) { this._daily_checked.add(token); this._queue_analysis(token, 'swing', this.daily[token]); }
    }
  }
  _queue_analysis(token, strategy, bars, context = this._strategy_context(token,strategy)) {
    if (!bars.length) return;
    const key=keyFor(strategy,token),job={token:Number(token),strategy,bars:[...bars],context,strategy_options:this._strategy_options(),bar_time:isoIST(bars.at(-1).time),generation:this._analysis_generation,queued_at:monotonic(),analysis_id:++this._analysis_sequence};
    this._discard_candidates(token,strategy);
    this._analysis_requested.set(key,{analysis_id:job.analysis_id,bar_time:job.bar_time,context_key:this._context_key(context)});
    this._analysis_pending.set(key,job);
  }
  _context_key(context){return JSON.stringify([context.previous_bars,context.benchmark_bars,context.sector_bars]);}
  _strategy_context(token,strategy='intraday'){
    const source=this.market_context.contextForSymbol?.(this.universe[token]?.tradingsymbol,this._now())||{};
    return {as_of:isoIST(this._now()),previous_bars:strategy==='intraday'?(this.previous_intraday[token]||[]):[],
      benchmark_bars:strategy==='intraday'?(source.benchmark_bars||[]):(source.benchmark_daily_bars||source.daily_bars||[]),
      sector_bars:strategy==='intraday'?(source.sector_bars||[]):(source.sector_daily_bars||[])};
  }
  async _market_context_loop(signal){
    while(!signal?.aborted&&!this._shutdown){
      const activity=this._activity.begin('market_context',{message:'Refreshing benchmark, sector and event data.'});
      try {
        if(this.connected){await this.market_context.refresh(this);if(!signal?.aborted&&!this._shutdown&&this.connected)this._refresh_context_analyses();}
        activity({status:'waiting',message:this.connected?'Refresh pass finished; individual source coverage is shown in Market context.':'Waiting for Zerodha connection.',next_retry_at:new Date(+this._now()+60000).toISOString()});
      } catch(error) {activity({status:'failed',message:'Market context refresh failed.',failed:1});throw error;}
      await sleep(60000,signal);
    }
  }
  _refresh_context_analyses(){
    const now=this._now();
    for(const [token] of entries(this.universe)){
      if(monotonic()-(this.quotes[token]?.received_at??-Infinity)>10)continue;
      for(const strategy of ['intraday','swing']){
        const bars=strategy==='intraday'?this.books[token]?.bars:this.daily[token],last=bars?.at(-1);
        if(!last||strategy==='intraday'&&(dateIST(last.time)!==dateIST(now)||now-last.time-300000<0||now-last.time-300000>=300000))continue;
        const previous=this._analysis_requested.get(keyFor(strategy,token)),context=this._strategy_context(token,strategy);
        if(!previous||previous.bar_time!==isoIST(last.time)||previous.context_key!==this._context_key(context))this._queue_analysis(Number(token),strategy,bars,context);
      }
    }
  }
  _queue_current_analysis(token) {
    const now = this._now(), bars = this.books[token]?.bars || [], last = bars.at(-1);
    if (last && dateIST(last.time) === dateIST(now) && now - last.time - 300000 >= 0 && now - last.time - 300000 < 300000) this._queue_analysis(token, 'intraday', bars);
    if (this.daily[token]) { this._daily_checked.add(Number(token)); this._queue_analysis(token, 'swing', this.daily[token]); }
  }
  _intraday_warmed(token,book){return this.settings.enhanced_signals?book.bars.length>=2&&book.bars.length+(this.previous_intraday[token]?.length||0)>=34:book.bars.length>=21;}
  async _analysis_loop(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      while (this._analysis_pending.size && this._analysis_tasks.size < this.analytics.worker_limit) {
        const batch = [...this._analysis_pending.keys()].slice(0, this.analytics.batch_size).map(key => { const job = this._analysis_pending.get(key); this._analysis_pending.delete(key); return job; });
        let task;
        const batchId=++this._batch_sequence;
        this._last_analysis_error=null;
        this._last_analysis_at=isoIST(this._now());
        this._active_batches.set(batchId,{symbols:[...new Set(batch.map(job=>this.universe[job.token]?.tradingsymbol).filter(Boolean))].slice(0,32),symbol_count:batch.length,strategies:[...new Set(batch.map(job=>job.strategy))],started_at:isoIST(this._now())});
        task = Promise.resolve().then(() => this.analytics.analyze(batch)).then(results => this._analysis_finished(results)).catch(exc => {
          const failure = failureMetadata(exc, 'analytics', 'analyze');
          if (!signal?.aborted && !this._shutdown) {this._last_analysis_error=`Parallel analytics failed (${failure.kind}). Entries paused; account monitoring continues.`;this._halt(`Parallel analytics failed (${failure.kind}); entries paused while monitoring and exits continue.`, 'analytics_error', failure);}
        }).finally(() => {this._analysis_tasks.delete(task);this._active_batches.delete(batchId);this._last_analysis_at=isoIST(this._now());});
        this._analysis_tasks.add(task);
      }
      await sleep(100, signal);
    }
  }
  _analysis_finished(results) {
    if (this._shutdown) return;
    for (const result of results) {
      const { token, strategy } = result; if (result.generation !== this._analysis_generation) continue;
      const bars = strategy === 'intraday' && this.books[token] ? this.books[token].bars : (this.daily[token] || []);
      if (!bars.length || isoIST(bars.at(-1).time) !== result.bar_time) continue;
      if (monotonic() - result.queued_at > 30) { this._stats.stale_analysis_dropped = (this._stats.stale_analysis_dropped || 0) + 1; if (strategy === 'swing') this._daily_checked.delete(Number(token)); continue; }
      if(result.analysis_id!==this._analysis_requested.get(keyFor(strategy,token))?.analysis_id)continue;
      this._discard_candidates(token,strategy);
      this._analysis_cache.set(keyFor(strategy, token), result);
      const stat = `${strategy}:${result.reason}`; this._stats[stat] = (this._stats[stat] || 0) + 1;
      if (result.signal) this._candidate(token, new Signal(result.signal), result.metrics,{generation:result.generation,analysis_id:result.analysis_id,bar_time:result.bar_time,queued_at:result.queued_at});
    }
  }
  _discard_candidates(token,strategy){
    this._candidates=this._candidates.filter(([t,s,,record])=>{if(t!==Number(token)||s.strategy!==strategy)return true;record.status='superseded_analysis';return false;});
    if(!this._candidates.length)this._candidate_batch_at=null;
  }
  _candidate(token, signal, metrics = {}, source = null) {
    const record = { time: isoIST(this._now()), symbol: this.universe[token].tradingsymbol, ...signal, source, status: 'candidate', analytics: metrics || {} };
    this.signals.unshift(record); this.signals.length = Math.min(60, this.signals.length);
    this._stats['candidates:'+signal.strategy] = (this._stats['candidates:'+signal.strategy] || 0) + 1;
    this._discard_candidates(token,signal.strategy);
    this._candidates.push([Number(token), signal, monotonic(), record]);
    this._rank_candidates();
    if(this._candidates.length>200){const dropped=this._candidates.pop();dropped[3].status='lower_ranked_overflow';}
    this._candidate_batch_at??=monotonic();
  }

  _strategy_options(){return Object.fromEntries(['enhanced_signals','enable_breakout','enable_pullback','enable_reversion','candlestick_patterns_enabled','technical_exit_enabled','min_signal_score','min_adx','min_rsi','max_rsi','max_atr_extension',
    'enable_opening_range','enable_opening_drive','enable_gap_continuation','enable_gap_reversal','enable_vwap_reclaim','enable_vwap_rejection','enable_volatility_squeeze','enable_relative_strength','intraday_short_enabled','higher_timeframe_filter','opening_range_minutes','min_setup_volume','min_gap_pct','max_gap_pct','relative_strength_min','squeeze_width_max','squeeze_lookback'].filter(k=>this.settings[k]!==undefined).map(k=>[k,this.settings[k]]));}
  _rank_candidates(){this._candidates.sort((a,b)=>(Number.isFinite(b[1].score)?b[1].score:0)-(Number.isFinite(a[1].score)?a[1].score:0)||a[3].symbol.localeCompare(b[3].symbol)||a[1].strategy.localeCompare(b[1].strategy));}
  _portfolio(){return portfolioExposure({account:this.account,positions:this.positions,intents:this.intents,delivery:this.delivery?.snapshot()||{},quotes:this.quotes,universe:this.universe,cash:this._available_cash(),capital:this.capital,mode:this.mode,settings:this.settings,clock:monotonic()});}
  _runtime_block(){
    const r=this.runtime_health?.();if(!r)return null;
    if(!Number.isFinite(r.disk_free_mib)||r.disk_free_mib<this.settings.min_free_disk_mib)return 'journal_disk_capacity';
    if(!Number.isFinite(r.memory_free_mib)||r.memory_free_mib<this.settings.min_free_memory_mib)return 'system_memory_pressure';
    if(!Number.isFinite(r.event_loop_delay_ms)||r.event_loop_delay_ms>this.settings.max_event_loop_delay_ms)return 'event_loop_pressure';
    return null;
  }
  _clock_block() {
    const health = this.broker?.clock_health?.();
    return !health ? null : health.blocked ? 'system_clock_skew' : health.status !== 'aligned' || health.stale ? 'system_clock_unverified' : null;
  }
  readiness(){
    const clock=monotonic(),runtime=this._runtime_block(),context=this.market_context.snapshot(),brokerClock=this.broker?.clock_health?.();
    const checks=[
      {key:'broker_session',ok:this.connected&&this._profile_verified,detail:'Authenticated account identity verified.'},
      ...(brokerClock?[{key:'system_clock',ok:!this._clock_block(),detail:brokerClock.blocked?'The broker and system clocks disagree. Synchronize the operating-system clock; new entries wait.':brokerClock.status!=='aligned'||brokerClock.stale?'Waiting for a recent, bounded broker clock check.':'Recent broker response time agrees with the system clock within the freshness tolerance.'}]:[]),
      {key:'equity_universe',ok:this.universe_summary?.status==='verified'&&this._universe_date===dateIST(this._now()),detail:this.universe_summary?.status==='verified'?`${values(this.universe).filter(i=>i.entry_eligible!==false).length} stocks and ETFs verified against NSE security lists; managed instruments outside that scope remain exit-only.`:'Waiting for current NSE stock and ETF lists. Managed exposure stays monitored; new entries are blocked.'},
      {key:'account_snapshot',ok:this.connected&&clock-this._account_at<=45,detail:'Orders, positions, holdings and cash observed within 45 seconds.'},
      {key:'trading_cash',ok:this.capital>0&&(this.mode==='paper'||this._available_cash()>0),detail:'Positive trading budget required; live entries also require verified available Zerodha cash.'},
      {key:'reconciliation',ok:this.recovery.phase==='ready'&&!this._unresolved_intents(),detail:this.recovery.message},
      {key:'market_session',ok:marketHours(this._now()),detail:'Regular NSE session hours; individual fresh quotes are still required.'},
      {key:'live_feed',ok:clock-this._last_tick_received<=10,detail:'An exchange-timestamped tick arrived within 10 seconds.'},
      {key:'machine_capacity',ok:!runtime,detail:runtime||'Journal disk, available RAM and event loop checks pass.'},
      {key:'maintenance',ok:!this._maintenance(),detail:'No maintenance lock.'},
      {key:'entry_armed',ok:this.running,detail:'Start Trading is armed.'},
    ];
    return {ready:checks.every(c=>c.ok),checks,market_context:context,scope:'Operational prerequisites only. Each candidate must also pass strategy, calendar, liquidity, cash and account risk checks.'};
  }
  _update_loss_control(){
    const state=this._loss_control;
    if(state.day!==this.day){Object.assign(state,{day:this.day,last_realised:this.realised,loss_events:0,until:null});return;}
    const delta=this.realised-state.last_realised;if(Math.abs(delta)<0.005)return;
    state.last_realised=this.realised;state.loss_events=delta<0?state.loss_events+1:0;
    if(this.settings.loss_streak_limit&&state.loss_events>=this.settings.loss_streak_limit){
      state.until=isoIST(new Date(+this._now()+this.settings.loss_cooldown_minutes*60000));state.loss_events=0;
      this._event('risk_cooldown','New entries cooling down after consecutive realized loss events. Existing exits remain active.',{until:state.until},'warning');
    }
    this._persist();
  }
  _decision_controls(){
    const regime=marketBreadth(this.universe,this.quotes,this.settings,monotonic()),portfolio=this._portfolio(),blocked_reasons=[];
    const until=parseTime(this._loss_control.until),cooling=until&&until>this._now();
    if(['warming_up','defensive'].includes(regime.status))blocked_reasons.push(regime.message);
    if(this.universe_summary&&(this.universe_summary.status!=='verified'||this._universe_date!==dateIST(this._now())))blocked_reasons.push('Current NSE stock and ETF eligibility is unverified.');
    if(cooling)blocked_reasons.push('New entries are in a loss cooldown.');
    if(this.settings.portfolio_risk_enabled&&(portfolio.unpriced_symbols.length||portfolio.unsupported_symbols.length))blocked_reasons.push('Some account exposure cannot be valued safely.');
    if(this.settings.max_trades_per_day&&this.traded.size>=this.settings.max_trades_per_day)blocked_reasons.push('Daily new-symbol limit reached.');
    return {strategy_version:STRATEGY_VERSION,regime,portfolio,blocked_reasons,cooldown:{until:cooling?this._loss_control.until:null,loss_events:this._loss_control.loss_events,message:cooling?'Cooling down new entries.':'No loss cooldown active.'},candidate_count:this._candidates.length,
      market_context:this.market_context.snapshot(),ranked_candidates:this._candidates.slice(0,10).map(([,s,,r])=>({symbol:r.symbol,strategy:s.strategy,side:sideOf(s),setup:s.setup,score:s.score,reason:s.reason}))};
  }
  _correlation_gate(token,notional,portfolio){
    if(this.settings.correlation_filter!==true||!portfolio.rows.length)return null;
    const symbol=this.universe[token].tradingsymbol,tokens=Object.fromEntries(entries(this.universe).map(([t,i])=>[i.tradingsymbol,Number(t)]));
    let exposure=notional;const missing=[];
    for(const row of portfolio.rows){
      if(row.symbol===symbol){exposure+=row.exposure;continue;}
      const other=tokens[row.symbol],correlation=returnCorrelation(this.daily[token]||[],this.daily[other]||[]);
      if(correlation===null){missing.push(row.symbol);if(other)this._correlation_wanted.add(other);continue;}
      if(Math.abs(correlation)>=this.settings.max_correlation)exposure+=row.exposure;
    }
    if(missing.length){this._correlation_wanted.add(Number(token));return 'correlation_history_unavailable';}
    return exposure>portfolio.reference_assets*this.settings.max_correlated_exposure_pct?'correlated_exposure_limit':null;
  }

  async _run_once() {
    this._roll_day(); this._update_loss_control(); const now = this._now();
    if (this.connected && marketHours(now)) {
      for (const [symbol, position] of entries(this.positions)) {
        const quote = this.quotes[position.token] || {}, fresh = monotonic() - (quote.received_at ?? -Infinity) <= 10, opened = parseTime(position.opened_at);
        const overdue = opened && dateIST(opened) < dateIST(now);
        if (position.strategy === 'intraday' && (timeIST(now) >= this.settings.exit_time || overdue)) await this._exit_locked(symbol, overdue ? 'overdue_intraday_exit' : 'intraday_session_exit');
        else if (fresh) {
          const last = Number(quote.last_price);
          if(this.mode==='paper'&&position.strategy==='swing'){
            const daily=this.daily[position.token]||[],lastDaily=daily.at(-1);
            const usable=lastDaily&&dateIST(lastDaily.time)<dateIST(now)&&now-lastDaily.time<7*86400000;
            const holdingExit=usable?daily_holding_exit(daily,position):null;
            if(holdingExit){
              if(position.trailing_stop!==holdingExit.trailing_stop){position.trailing_stop=holdingExit.trailing_stop;this._persist();}
              if(holdingExit.trend_exit||last<=position.trailing_stop){await this._exit_locked(symbol,holdingExit.trend_exit?'Daily trend loss':'Daily ATR trailing exit');continue;}
            }
          }
          if (directionOf(position) * (last - position.stop) <= 0) await this._exit_locked(symbol, 'stop_loss');
          else if (directionOf(position) * (last - position.target) >= 0) await this._exit_locked(symbol, 'profit_target');
          else if(this.settings.enhanced_signals&&this.settings.technical_exit_enabled){
            const bars=position.strategy==='intraday'?(this.books[position.token]?.bars||[]):(this.daily[position.token]||[]),lastBar=bars.at(-1);
            const current=lastBar&&(position.strategy==='intraday'?dateIST(lastBar.time)===dateIST(now)&&now-lastBar.time>=300000&&now-lastBar.time<600000:now-lastBar.time<7*86400000);
            if(current){const exit=technical_exit(bars,position,this._strategy_options(),this._strategy_context(position.token,position.strategy));if(exit?.exit)await this._exit_locked(symbol,exit.reason);}
          }
        }
      }
      if (this._daily_pnl() <= -this.capital * this.settings.daily_loss_pct && this.capital > 0) {
        this._halt('Daily loss limit reached; new entries stopped and bot exits requested.');
        for (const symbol of Object.keys(this.positions)) await this._exit_locked(symbol, 'daily_loss_limit');
      }
      if (monotonic() - this._last_holdings_scan >= (this.recovery.phase !== 'ready' ? 5 : 60)) {
        this._analyze_holdings(); let evaluated = true, outcome = {};
        if (this.delivery) {
          const bars = Object.fromEntries(entries(this.daily).filter(([t]) => this.universe[t]).map(([t, b]) => [this.universe[t].tradingsymbol, b]));
          const quotes = Object.fromEntries(entries(this.quotes).filter(([t]) => this.universe[t]).map(([t, q]) => [this.universe[t].tradingsymbol, { ...q, tick_size: this.universe[t].tick_size || .05 }]));
          outcome = await this.delivery.evaluate_holdings(bars, this._holding_management_settings(), quotes, { adopt_new: this.running });
          evaluated = !outcome.blocked; this._sync_delivery();
        }
        const required = this._managed_recovery_symbols(), tokens = Object.fromEntries(entries(this.universe).map(([t, i]) => [i.tradingsymbol, Number(t)]));
        this._recovery_holdings_checked = evaluated && entries(required).every(([symbol, daily]) => !daily || (this.delivery ? (outcome.evaluated_symbols || []).includes(symbol) : Boolean(this._analysis_cache.get(keyFor('swing', tokens[symbol]))?.holding)));
        this._last_holdings_scan = monotonic();
      }
    }
    if(this.mode==='live'&&this.holdings_authorization.snapshot().required&&this.recovery.phase==='ready'){
      this._invalidate_decisions();this._recovery_holdings_checked=false;
      Object.assign(this.recovery,{phase:'awaiting_authorization',blocked:true,completed_at:null,message:'Complete the required holdings authorization on Zerodha/CDSL.'});
    }
    this._advance_recovery();
    this._update_loss_control();this._rank_candidates();
    const batchReady=this._candidate_batch_at===null||monotonic()-this._candidate_batch_at>=(this.settings.candidate_wait_ms||0)/1000;
    for (let left = batchReady?Math.min(10, this._candidates.length):0; left > 0; left--) {
      const [token, signal, received, record] = this._candidates.shift();
      if (monotonic() - received <= 30) {
        const reason = record.source ? await this._enter_locked(token, signal,record.source) : 'signal_source_missing'; record.status = reason;
        const rejection = reason === 'cover_order_rejected' ? values(this.intents).findLast(intent=>intent.symbol===record.symbol && intent.rejection)?.rejection : null;
        if (rejection) record.reason = `${rejection.message} (${rejection.kind}, HTTP ${rejection.http_status})`;
        if (reason === 'existing_holdings_ignored') record.reason = 'This stock is already owned and excluded by your existing-holdings setting.';
        this._stats['decision:'+reason] = (this._stats['decision:'+reason] || 0) + 1;
        if (/^(cover_order_|delivery_|paper_(buy|short)_filled)/.test(reason))
          this._event('decision', `${record.symbol}: ${reason}${rejection ? `. ${record.reason}` : ''}`, { symbol: record.symbol, strategy: signal.strategy,side:sideOf(signal),setup:signal.setup,score:signal.score, decision: reason, ...(rejection ? {rejection} : {}) }, rejection ? 'error' : 'info');
      }
    }
    if(!this._candidates.length)this._candidate_batch_at=null;
    if (monotonic() - this._last_summary >= 300 && count(this._stats)) {
      const candidates=sum(entries(this._stats).filter(([key])=>key.startsWith('candidates:')).map(([,n])=>n)),decisions=sum(entries(this._stats).filter(([key])=>key.startsWith('decision:')).map(([,n])=>n));
      this._event('scan_summary', `Scanner summary: ${candidates} candidates and ${decisions} entry checks. Individual signals remain in Overview → Latest analysis.`, { ...this._stats }); this._stats = {}; this._last_summary = monotonic();
    }
    if (monotonic() - this._last_persist >= 15) { this._persist(); this._last_persist = monotonic(); }
  }
  async _run(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      const activity=this._activity.begin('execution',{status:'waiting',message:'Waiting for the account and execution lock.'});
      try {
        await this._lock.run(async () => { if (!signal?.aborted && !this._shutdown) {activity({status:'running',message:'Checking current positions, exits and eligible trade candidates.'});await this._run_once();} });
        activity({status:'waiting',message:this.running?'Decision pass finished. New entries require all entry checks.':'Decision pass finished. New entries are paused; position management continues.',next_retry_at:new Date(+this._now()+1000).toISOString()});
        await sleep(1000, signal);
      } catch (exc) {
        if (signal?.aborted || this._shutdown) return;
        const failure = failureMetadata(exc, 'trading_loop', 'execution');
        activity({status:'failed',message:`Decision pass interrupted (${failure.kind}); entries paused. The loop will retry.`,failed:1,next_retry_at:new Date(+this._now()+2000).toISOString()});
        this._halt(`Trading loop interrupted (${failure.kind}); entries paused.`, 'engine_error', failure); await sleep(2000, signal);
      }
    }
  }
  async _wait_reconciliation(signal) {
    if (signal?.aborted || this._reconcile_requested) return;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); if (this._wakeMonitor === finish) this._wakeMonitor = null; resolve(); };
      const timer = setTimeout(finish, 15000); this._wakeMonitor = finish; signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted || this._reconcile_requested) finish();
    });
  }
  async _monitor(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      let stage = 'account';
      try {
        this._reconcile_requested = false;
        await this._lock.run(async () => {
          if(signal?.aborted||this._shutdown)return;
          await this._refresh_account_locked();
          if(this.connected&&this._universe_date!==dateIST(this._now())&&monotonic()>=this._universe_retry_at){stage='universe';await this._refresh_universe_locked(null,value=>{stage=value;});stage='recovery';this._advance_recovery();}
        });
        stage = 'waiting';
        await this._wait_reconciliation(signal);
      } catch (exc) {
        if (signal?.aborted || this._shutdown) return;
        const failure = failureMetadata(exc, 'account_monitor', stage);
        if (exc instanceof BrokerError && exc.kind === 'TokenException') {
          this.connected = false; this._halt('Zerodha authentication expired. Reconnect immediately; existing broker cover stops remain subject to broker execution.', 'auth_expired', failure);
        } else this._halt(`Account monitoring interrupted (${failure.kind}); entries paused until reconciliation recovers.`, 'account_error', failure);
        await sleep(15000, signal);
      }
    }
  }
  async _refresh_account_locked({ rebase_capital = false, authorization_user_confirmed=false, reconcile_positions=true, onProgress } = {}) {
    const activity=this._activity.begin('account',{message:'Downloading balances, holdings, positions, orders and trades.',total:6});
    try {
    const wasWaitingForFunds = this._waiting_for_funds();
    const account = await this.broker.account(progress=>{activity({message:progress.message,completed:progress.completed});onProgress?.(progress);});
    activity({message:'Reconciling current balances, holdings and order protection.',completed:5});
    for (const order of account.orders || []) this._record_order(order);
    for (const trade of account.trades || []) {
      const key = JSON.stringify([String(trade.order_id), String(trade.trade_id)]);
      if (!this._trade_seen.has(key)) { this._trade_seen.add(key); this._event('account_trade', `Executed trade: ${trade.tradingsymbol || ''}`, trade); }
    }
    const signature = JSON.stringify((account.positions?.net || []).map(p => [String(p.exchange), String(p.tradingsymbol), String(p.product), Number(p.quantity || 0)]).sort());
    if (signature !== this._position_seen) { this._event('account_positions', 'Zerodha account positions changed (includes manual trades).', account.positions); this._position_seen = signature; }
    const holdings = JSON.stringify((account.holdings || []).map(h => [String(h.exchange), String(h.tradingsymbol), Number(h.quantity || 0), Number(h.t1_quantity || 0), Number(h.used_quantity || 0), Number(h.collateral_quantity || 0), round(Number(h.average_price || 0), 4)]).sort());
    if (holdings !== this._holdings_seen) { this._event('account_holdings', 'Zerodha holdings quantities or cost basis changed.', account.holdings || []); this._holdings_seen = holdings; }
    const margins = account.margins || {}, balances = JSON.stringify(['equity', 'commodity'].map(segment => [segment, ...['cash', 'live_balance', 'collateral', 'intraday_payin'].map(k => Math.round(Number(margins[segment]?.available?.[k] || 0)))]));
    if (balances !== this._balance_seen && (this._balance_seen === null || monotonic() - this._balance_logged_at >= 60)) { this._event('account_balances', 'Zerodha available balances changed (sampled at most once per minute).', margins); this._balance_seen = balances; this._balance_logged_at = monotonic(); }
    this.account = account; this._account_at = monotonic(); this.store.set('account_snapshot', account);
    const clockHealth = this.broker?.clock_health?.(), clockState = this._clock_block();
    if (clockHealth && this._clock_seen !== (clockState || 'aligned')) {
      this._clock_seen = clockState || 'aligned';
      this._event('system_clock', clockState === 'system_clock_skew' ? 'System clock differs from Zerodha. Synchronize the operating-system clock; new entries wait.' : clockState ? 'System clock verification is pending; new entries wait.' : 'System clock alignment verified against recent broker response time.', clockHealth, clockState ? 'warning' : 'info');
    }
    if (clockHealth?.blocked) {
      this._invalidate_decisions(); this.quotes = {}; this._last_tick_received = -Infinity; this._heartbeat = null;
    }
    if(this.mode==='live'&&this.holdings_authorization.snapshot().required){
      this._profile=await this.broker.call('profile');this._reconcile_authorization(this._profile,{userConfirmed:authorization_user_confirmed});
    }
    // Authorization controls only verify broker data. Ordinary engine monitoring
    // owns position reconciliation, which can modify protective orders.
    if (this.mode === 'live' && reconcile_positions) { await this._reconcile_live_locked(); await this.delivery.reconcile(account); this._sync_delivery(); }
    if (this.running && this.capital > 0 && this._daily_pnl() <= -this.capital * this.settings.daily_loss_pct) this._halt('Daily loss limit reached; new entries stopped and bot exits requested.');
    this._update_capital(rebase_capital);
    if (this.mode !== 'live' || reconcile_positions) this._recovery_account_verified = true;
    this._update_running_message();
    if (wasWaitingForFunds && this.running && !this._waiting_for_funds()) {
      // Funding never arms the engine. An already-armed session re-evaluates
      // current completed candles instead of carrying a pre-funding decision.
      this._invalidate_decisions();
      if (this.recovery.phase === 'ready') for (const token of Object.keys(this.universe)) if (monotonic() - (this.quotes[token]?.received_at ?? -Infinity) <= 10) this._queue_current_analysis(Number(token));
    }
    this._persist();
    activity({status:'waiting',message:'Account reconciled. Monitoring order events; the next periodic check is scheduled in about 15 seconds.',completed:6,next_retry_at:new Date(+this._now()+15000).toISOString()});
    } catch(error) {activity({status:'failed',message:'Account reconciliation failed. New entries remain subject to account safety checks.',failed:1});throw error;}
  }
  _available_cash() {
    return this._cash_balance() ?? 0;
  }
  _cash_balance() {
    const margin = this.account.margins?.equity || {}, available = margin.available || {};
    const raw = [available.cash, available.live_balance ?? margin.net, available.collateral ?? 0, available.adhoc_margin ?? 0];
    if (!raw.every(value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)))) return null;
    const fields = raw.map(Number);
    if (fields[2] < 0 || fields[3] < 0) return null;
    let cashCeiling = fields[0];
    const funding = [available.opening_balance, available.intraday_payin];
    if (funding.some(value => value !== undefined && !((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value))))) return null;
    if (available.intraday_payin !== undefined && Number(available.intraday_payin) < 0) return null;
    if (funding.every(value => value !== undefined)) {
      // Kite can leave cash at the opening balance after a same-day deposit.
      // Compare with opening + pay-in instead of adding pay-in to cash: some
      // responses already include it. The current free balance remains a cap.
      const fundedCash = Number(available.opening_balance) + Number(available.intraday_payin);
      if (!Number.isFinite(fundedCash)) return null;
      cashCeiling = Math.max(cashCeiling, fundedCash);
    }
    return Math.max(0, Math.min(cashCeiling, fields[1] - fields[2] - fields[3]));
  }
  _update_capital(rebase = false) {
    const cash = this._cash_balance();
    this._broker_available_cash = cash ?? 0;
    if (cash === null) return;
    if (this.mode === 'paper') {
      if (!this._paper_capital_seeded && this._broker_available_cash > 0) {
        this.capital = this._broker_available_cash; this._capital_accounted_pnl = 0; this._paper_capital_seeded = true;
        this._event('capital_initialized', 'Paper starting balance initialized from verified available Zerodha cash; simulated results persist across restarts.', { capital: this.capital });
      }
      return;
    }
    const exposed = count(this.positions) > 0 || values(this.intents).some(i => !['closed', 'rejected'].includes(i.state)) || values(this.delivery?.snapshot().positions || {}).some(p => p.source === 'swing' && p.status !== 'closed');
    if (!exposed && (rebase || this.capital <= 0)) {
      const changed = this.capital !== this._broker_available_cash;
      this.capital = this._broker_available_cash; this._capital_accounted_pnl = this.realised;
      if (changed) this._event('capital_refreshed', 'Live budget refreshed from verified available Zerodha cash while bot exposure is flat.', { capital: this.capital });
    } else if (!exposed && this.running) {
      // With no owned exposure, verified cash reconciles deposits/withdrawals.
      // Keep trading P&L separate from funding. If a withdrawal exhausts the
      // original principal, account for profit already withdrawn/retained in
      // the cash baseline immediately, keeping equity equal to verified cash.
      // Total realised results and daily/loss-control baselines never change.
      let capital = this._broker_available_cash - (this.realised - this._capital_accounted_pnl);
      const accounted = capital <= 0 ? this.realised : this._capital_accounted_pnl;
      if (capital <= 0) capital = this._broker_available_cash;
      if (Math.abs(capital - this.capital) >= .005 || accounted !== this._capital_accounted_pnl) {
        this.capital = capital; this._capital_accounted_pnl = accounted;
        this._event('capital_refreshed', 'Live funding budget reconciled from verified available Zerodha cash while bot exposure is flat; total realised results remain unchanged.', { capital: this.capital, capital_accounted_pnl: this._capital_accounted_pnl });
      }
    } else if (this.capital <= 0) {
      // A legacy journal may have open positions but no capital baseline. Keep
      // its owned exposure represented without treating broker leverage as cash.
      this.capital = Math.max(this._broker_available_cash, this._exposure()); this._capital_accounted_pnl = this.realised;
      this._event('capital_recovered', 'Recovered live risk baseline from current cash and existing owned exposure; every new entry still requires unleveraged cash.', { capital: this.capital });
    }
  }
  _unresolved_intents() { return values(this.intents).some(i => unresolved.has(i.state)) || Boolean(this.delivery?.snapshot().blocked); }
  _sync_delivery() {
    if (!this.delivery) return;
    const state = this.delivery.snapshot();
    for (const [symbol, p] of entries(this.positions)) if (p.strategy === 'swing') delete this.positions[symbol];
    for (const [symbol, p] of entries(state.positions || {})) if (p.source === 'swing' && p.status !== 'closed' && p.remaining_quantity > 0) {
      const token = Number(p.token || 0); this.positions[symbol] = { ...p, quantity: p.remaining_quantity, last: this.quotes[token]?.last_price ?? p.last ?? p.entry };
    }
    const realised = Number(state.bot_realised_pnl || 0); this.realised += realised - this._delivery_accounted; this._delivery_accounted = realised;
    if (state.blocked) this._halt(`Delivery order/protection needs attention: ${(state.reasons || []).slice(0, 3).join('; ')}`, 'delivery_blocked');
  }
  _roll_day() {
    const today = dateIST(this._now()); if (today === this.day) return;
    this.day = today; this.day_baseline = this.realised; this.day_open_unrealised = this._unrealised(); this.traded.clear(); this._daily_checked.clear(); this._intraday_history_loaded.clear(); this._invalidate_decisions();
    this.books = Object.fromEntries(Object.keys(this.universe).map(t => [t, new CandleBook()])); this.quotes = {}; this.daily = {}; this.previous_intraday={};this._intraday_history_retry={}; this._history_date = ''; this._daily_history_retry = {}; this._recovery_holdings_checked = false;
    Object.assign(this.recovery, { phase: 'warming_up', message: 'New session: refresh market data and select Start Trading after Zerodha authentication.', blocked: true, completed_at: null });
    this._order_seen = {}; this._trade_seen.clear(); this.running = false;
    this._correlation_wanted.clear();this._loss_control={day:today,last_realised:this.realised,loss_events:0,until:null};
    this._event('day_rollover', 'New trading day. Daily risk baseline reset; Start Trading is required again.'); this.status = this.connected ? 'paused' : 'disconnected'; this._persist();
  }
  _unrealised() { return sum(values(this.positions).map(markedProfit)); }
  _daily_pnl() { return this.realised - this.day_baseline + this._unrealised() - this.day_open_unrealised; }
  _exposure(strategy = null) {
    const positions = sum(values(this.positions).filter(p => strategy === null || p.strategy === strategy).map(p => p.entry * p.quantity));
    const pending = sum(values(this.intents).filter(i => (i.state==='pending'||unresolved.has(i.state)) && (strategy === null || i.strategy === strategy)).map(i => i.entry * Math.max(0, i.quantity - (i.filled || 0))));
    const deliveryState=this.delivery?.snapshot()||{};
    const delivery = this.delivery && (strategy === null || strategy === 'swing') ? sum(values(deliveryState.positions || {}).map(p => Number(p.entry_price || 0) * pendingDeliveryQuantity(p,deliveryState))) : 0;
    return positions + pending + delivery;
  }

  async _enter_locked(token, signal, source = null) {
    if (!this.running) return 'entries_paused';
    if(!this.universe[token]||this.universe[token].entry_eligible===false)return 'instrument_not_entry_eligible';
    if(this.universe_summary&&(this.universe_summary.status!=='verified'||this._universe_date!==dateIST(this._now())))return 'equity_directory_unavailable';
    const runtimeBlock=this._runtime_block();if(runtimeBlock)return runtimeBlock;
    const side=sideOf(signal),direction=directionOf(signal);
    if(!['BUY','SELL'].includes(side))return 'invalid_signal_side';
    if(side==='SELL'&&(signal.strategy!=='intraday'||this.settings.intraday_short_enabled!==true))return 'short_strategy_disabled';
    if (this._maintenance()) { this.running = false; return 'maintenance_active'; }
    const now = this._now();
    if(source){
      const bars=signal.strategy==='intraday'?this.books[token]?.bars:this.daily[token],last=bars?.at(-1),request=this._analysis_requested.get(keyFor(signal.strategy,token));
      if(source.generation!==this._analysis_generation||source.analysis_id!==request?.analysis_id||!last||isoIST(last.time)!==source.bar_time||monotonic()-source.queued_at>30)return 'signal_superseded';
      if(signal.strategy==='intraday'?(dateIST(last.time)!==dateIST(now)||now-last.time-300000<0||now-last.time-300000>=300000):(dateIST(last.time)>=dateIST(now)||now-last.time>7*86400000))return 'signal_candle_stale';
    }
    if (!marketHours(now)) return 'market_closed';
    if (signal.strategy === 'intraday' && timeIST(now) >= this.settings.entry_cutoff) return 'entry_cutoff';
    if (signal.strategy === 'swing' && timeIST(now) >= '15:15') return 'swing_entry_cutoff';
    const config = this.strategy_settings(); if (!config[`${signal.strategy}_enabled`]) return 'strategy_disabled';
    const allocation = Number(config[`${signal.strategy}_capital`] || 0);
    const allocationFractions = ['intraday', 'swing'].map(s => Number(config[`${s}_allocation_pct`] ?? 0));
    if (!Number.isFinite(allocation) || allocation <= 0 || allocationFractions.some(c => !Number.isFinite(c) || c < 0) || sum(allocationFractions) > 1.0000001) return 'invalid_capital_allocation';
    if (this._unresolved_intents()) return 'unresolved_order';
    if (this.recovery.phase !== 'ready') return 'recovery_incomplete';
    if (monotonic() - this._account_at > 45 || !this.connected) return 'account_data_stale';
    const clockBlock = this._clock_block(); if (clockBlock) return clockBlock;
    if (this._daily_pnl() <= -this.capital * this.settings.daily_loss_pct) return 'daily_loss_limit';
    this._update_loss_control();
    if(parseTime(this._loss_control.until)>now)return 'loss_cooldown';
    if(this.settings.max_trades_per_day&&this.traded.size>=this.settings.max_trades_per_day)return 'daily_trade_limit';
    const regime=marketBreadth(this.universe,this.quotes,this.settings,monotonic());
    if(regime.status==='warming_up')return 'market_breadth_unavailable';
    if(this.settings.market_regime_filter===true&&(side==='SELL'?regime.declining_fraction:regime.breadth)<this.settings.min_market_breadth)return 'market_breadth_defensive';
    const symbol = this.universe[token].tradingsymbol;
    if (config.manage_existing_holdings === 'ignore' && this._owns_holding(symbol)) return 'existing_holdings_ignored';
    if(this.settings.event_risk_enabled===true){const event=this.market_context.forSymbol(symbol);if(event.entry_blocked)return event.blackout?'scheduled_event_blackout':'event_calendar_unavailable';}
    if (this.positions[symbol] || this.traded.has(symbol) || values(this.intents).some(i => i.symbol === symbol && !['closed', 'rejected'].includes(i.state))) return 'already_owned_or_traded_today';
    const pendingCount = values(this.intents).filter(i => ['submitting', 'unknown', 'pending'].includes(i.state) && !this.positions[i.symbol]).length;
    if (count(this.positions) + pendingCount >= this.settings.max_positions) return 'maximum_positions';
    const quote = this.quotes[token] || {}; if (monotonic() - (quote.received_at ?? -Infinity) > 10) return 'quote_stale';
    const buys = quote.depth?.buy || [], sells = quote.depth?.sell || [];
    if (!buys.length || !sells.length || !(buys[0].price > 0) || !(sells[0].price > 0)) return 'market_depth_missing';
    const bid = Number(buys[0].price), ask = Number(sells[0].price);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid || (ask - bid) / ask > this.settings.max_spread_pct) return 'spread_too_wide';
    const turnover=Number(quote.volume_traded)*Number(quote.last_price);
    if (!Number.isFinite(turnover)||turnover < this.settings.min_daily_turnover) return 'turnover_too_low';
    const marketPrice=side==='SELL'?bid:ask;
    if (!Number.isFinite(signal.reference)||signal.reference<=0||Math.abs(marketPrice / signal.reference - 1) > (signal.strategy === 'intraday' ? .005 : .02)) return 'price_moved_from_signal';
    const tick_size = Number(this.universe[token].tick_size || .05);
    if(!Number.isFinite(tick_size)||tick_size<=0)return 'invalid_tick_size';
    const entry=round((direction===1?Math.ceil(ask*1.0005/tick_size):Math.floor(bid*.9995/tick_size))*tick_size,4);
    const stop=round((direction===1?Math.floor(signal.stop/tick_size):Math.ceil(signal.stop/tick_size))*tick_size,4);
    if(![entry,stop,signal.target].every(Number.isFinite)||Math.min(entry,stop,signal.target)<=0||direction*(entry-stop)<=0||direction*(signal.target-entry)<=0)return 'invalid_executable_reward';
    if(signal.strategy==='swing'){const gate=swing_entry_gate(this.daily[token]||[],{...signal,tick_size},entry);if(gate)return gate;}
    let remaining = Math.min(allocation - this._exposure(signal.strategy), this.capital + Math.min(0, this.realised - this._capital_accounted_pnl) - this._exposure());
    if (this.mode === 'live') {
      if (!this.settings.live_trading_enabled) return 'live_execution_disabled';
      if (this._account_symbol_busy(symbol)) return 'existing_account_exposure';
      remaining = Math.min(remaining, Math.max(0, this._available_cash() - this._exposure()));
    }
    const quantity = position_size(allocation, remaining, entry, stop, this.settings.risk_per_trade_pct, this.settings.max_position_pct,side);
    if (quantity < 1) return 'insufficient_risk_or_cash_budget';
    const portfolio=this._portfolio(),portfolioGate=portfolioEntryGate(portfolio,{symbol,entry,stop,quantity,side},this.settings);
    if(portfolioGate)return portfolioGate;
    const correlationGate=this._correlation_gate(token,entry*quantity,portfolio);if(correlationGate)return correlationGate;
    const visibleQuantity=Number((side==='SELL'?buys:sells)[0].quantity);
    if (!Number.isFinite(visibleQuantity)||visibleQuantity < quantity) return 'insufficient_visible_liquidity';
    let riskUsed = sum(values(this.positions).map(plannedRisk));
    riskUsed += sum(values(this.intents).filter(i => ['submitting', 'pending', 'unknown'].includes(i.state)).map(i => plannedRisk({...i,quantity:Math.max(0,i.quantity-(i.filled||0))})));
    if (riskUsed + plannedRisk({entry,stop,quantity,side}) > this.capital * this.settings.daily_loss_pct) return 'aggregate_risk_limit';
    if (this._maintenance() || !this.running) return 'entries_paused';
    if (this.mode === 'paper') {
      this.positions[symbol] = { symbol, token: Number(token), strategy: signal.strategy, setup:signal.setup, side, tick_size,quantity, entry, last: Number(quote.last_price), stop, target: signal.target, entry_fee: entry * quantity * FEE_RATE, opened_at: isoIST(now), protection: 'simulated', mode: 'paper' };
      this.traded.add(symbol); this._persist(); this._event('paper_fill', `Simulated ${side} ${quantity} ${symbol} at ${entry.toFixed(2)}.`, this.positions[symbol]); return side==='SELL'?'paper_short_filled':'paper_buy_filled';
    }
    if (signal.strategy === 'swing') {
      const result = await this.delivery.submit_entry(symbol, quantity, entry, stop, signal.target, tick_size, Number(token),signal.setup);
      if (result.position) this.traded.add(symbol);
      this._sync_delivery(); this._persist(); this.request_reconciliation(); return `delivery_${result.status || 'unknown'}${result.reason ? ': ' + result.reason : ''}`;
    }
    const tag = 'EB' + randomUUID().replaceAll('-', '').slice(0, 18);
    const intent = { tag, symbol, token: Number(token), strategy: signal.strategy, setup:signal.setup, side, quantity, entry, stop, target: signal.target, created_at: isoIST(now), state: 'submitting', filled: 0, exit_requested: [], pnl_accounted: 0 };
    this.intents[tag] = intent; this.traded.add(symbol); this._persist();
    this._event('order_intent', `Submitting protected cover ${side} ${quantity} ${symbol}.`, intent);
    try { intent.order_id = String(await this.broker[side==='SELL'?'sell_cover':'buy_cover'](symbol, quantity, entry, stop, tag)); intent.state = 'pending'; }
    catch (exc) {
      if (exc instanceof BrokerError && exc.definitive_rejection===true) {
        const failure = failureMetadata(exc, 'cover_entry', 'submission'), reason = orderRejectionReason(exc);
        intent.state = 'rejected'; intent.rejection = {...failure,...reason};
        this._event('order_rejected', `Cover entry rejected for ${symbol} (${failure.kind}${failure.http_status ? `, HTTP ${failure.http_status}` : ''}). ${reason.message}`, {tag,...intent.rejection}, 'error');
        if (['PermissionException', 'TokenException'].includes(exc.kind)) { if (exc.kind === 'TokenException') this.connected = false; this._halt(`Cover order rejected (${failure.kind}${failure.http_status ? `, HTTP ${failure.http_status}` : ''}). ${reason.message}`,'risk_halt',intent.rejection); }
      } else { intent.state = 'unknown'; this._halt(`Order acknowledgement unknown for ${symbol}; never retried automatically. Reconcile in Zerodha.`, 'order_unknown'); }
    }
    this._persist(); this.request_reconciliation(); return `cover_order_${intent.state}`;
  }
  _owns_holding(symbol) {
    // Settled, unsettled and pledged shares remain owned even when unavailable
    // for sale. Include delivery buys that have not reached the holdings API yet.
    return (this.account.holdings || []).some(h => h.tradingsymbol === symbol &&
      ['quantity','t1_quantity','collateral_quantity'].some(key => Number(h[key] || 0) > 0)) ||
      (this.account.positions?.net || []).some(p => p.tradingsymbol === symbol && p.product === 'CNC' && Number(p.quantity || 0) > 0);
  }
  _account_symbol_busy(symbol) {
    return (this.account.positions?.net || []).some(p => p.tradingsymbol === symbol && Number(p.quantity || 0) !== 0) || (this.account.holdings || []).some(p => p.tradingsymbol === symbol && Number(p.quantity || 0) + Number(p.t1_quantity || 0) > 0) || (this.account.orders || []).some(o => o.tradingsymbol === symbol && !TERMINAL.has(o.status));
  }
  async _exit_locked(symbol, reason) {
    const position = this.positions[symbol]; if (!position) return;
    if (this.mode === 'paper') {
      const quote = this.quotes[position.token] || {};
      const executable=directionOf(position)===1?bidOf(quote):askOf(quote);
      if (!marketHours(this._now()) || monotonic() - (quote.received_at ?? -Infinity) > 10 || !Number.isFinite(executable) || executable <= 0) return;
      const exit = executable * (directionOf(position)===1?.9995:1.0005), pnl = directionOf(position)*(exit - position.entry) * position.quantity - (position.entry_fee || 0) - exit * position.quantity * FEE_RATE;
      this.realised += pnl; delete this.positions[symbol]; this._persist(); this._event('paper_fill', `Simulated ${exitSideOf(position)} ${position.quantity} ${symbol}: ${reason}.`, { ...position, exit, pnl, reason, fees_estimated: true }); return;
    }
    if (!this.connected || monotonic() - this._account_at > 45) { this._halt('Cannot request exits with stale account data. Check existing cover stops in Zerodha.'); return; }
    if (position.strategy === 'swing') {
      const quote = this.quotes[position.token] || {};
      if (!marketHours(this._now()) || monotonic() - (quote.received_at ?? -Infinity) > 10 || bidOf(quote) <= 0) return;
      await this.delivery.request_exit(symbol, position.quantity, bidOf(quote), reason); this._sync_delivery(); this._persist(); this.request_reconciliation(); return;
    }
    const intent = this.intents[position.tag];
    if (!intent) { this._halt(`Ownership journal missing for ${symbol}; no independent SELL will be sent.`); return; }
    if (['unknown', 'conflict'].includes(intent.state)) { this._halt(`Cover ownership for ${symbol} is unresolved; no cancellation or independent sell was sent.`, 'ownership_conflict'); return; }
    const orders = intent.broker_orders?.length ? intent.broker_orders : (this.account.orders || []), parent = orders.find(o => String(o.order_id) === intent.order_id);
    if (parent && !TERMINAL.has(parent.status)) await this._request_cancel_locked(intent, parent, null, reason);
    const children = orders.filter(o => String(o.parent_order_id) === intent.order_id && !TERMINAL.has(o.status));
    for (const child of children) await this._request_cancel_locked(intent, child, intent.order_id, reason);
    if (!children.length && position.quantity > 0) this._halt(`No active cover child found for ${symbol}; inspect Zerodha immediately. No duplicate exit was submitted.`, 'protection_missing');
  }
  async _request_cancel_locked(intent, order, parent, reason) {
    const oid = String(order.order_id); intent.exit_requested ||= [];
    if (intent.exit_requested.includes(oid)) return;
    intent.exit_requested.push(oid); intent.exit_at = isoIST(this._now()); this._persist();
    this._event('cover_exit_request', `Requesting cover order cancellation/exit: ${intent.symbol}.`, { order_id: oid, parent_order_id: parent, reason });
    try { await this.broker.cancel_cover(oid, parent); }
    catch { intent.state = 'exit_unknown'; this._halt(`Exit acknowledgement unknown for ${intent.symbol}; reconcile before any further order.`, 'exit_unknown'); }
    this._persist(); this.request_reconciliation();
  }
  async _cancel_pending_entries_locked() {
    for (const intent of values(this.intents)) {
      const parent = (this.account.orders || []).find(o => String(o.order_id) === intent.order_id);
      if (parent && !TERMINAL.has(parent.status)) await this._request_cancel_locked(intent, parent, null, 'pause_entries');
    }
  }
  async _reconcile_live_locked() {
    const orders = this.account.orders || [], byId = Object.fromEntries(orders.map(o => [String(o.order_id), o]));
    for (const [tag, intent] of entries(this.intents)) {
      if (['closed', 'rejected'].includes(intent.state)) continue;
      const side=sideOf(intent),exitSide=exitSideOf(intent),direction=directionOf(intent);
      if(!['BUY','SELL'].includes(side)){intent.state='conflict';this._halt('Invalid side in cover ownership journal.');continue;}
      const matches = orders.filter(o => (o.tag === tag || (o.tags || []).includes(tag)) && !o.parent_order_id);
      if (matches.length > 1) { intent.state = 'conflict'; this._halt(`Multiple broker orders match intent ${tag}; manual reconciliation required.`); continue; }
      let parent = byId[intent.order_id] || matches[0];
      if (!parent && intent.order_id) {
        try { parent = (await this.broker.call('order_history', intent.order_id)).at(-1); } catch { parent = null; }
        if (!parent && TERMINAL.has(intent.broker_parent?.status) && validBrokerFill(intent.broker_parent)) parent = intent.broker_parent;
      }
      if (!parent) { intent.state = 'unknown'; this._halt(`Unresolved order intent for ${intent.symbol}; no automatic resubmission.`); continue; }
      intent.order_id = String(parent.order_id);
      if (parent.variety !== 'co' || parent.transaction_type !== side || parent.exchange !== 'NSE' || parent.tradingsymbol !== intent.symbol || !['MIS', 'CO'].includes(parent.product) || Number(parent.quantity ?? -1) !== Number(intent.quantity)) {
        intent.state = 'conflict'; this._halt('Broker order does not match protected directional ownership journal.'); continue;
      }
      const children = orders.filter(o => String(o.parent_order_id) === intent.order_id); let missingChild = false;
      for (const prior of intent.broker_children || []) {
        if (children.some(o => String(o.order_id) === String(prior.order_id))) continue;
        let resolved = TERMINAL.has(prior.status) && validBrokerFill(prior) ? prior : null;
        if (!resolved) { try { resolved = (await this.broker.call('order_history', String(prior.order_id))).at(-1); } catch { resolved = null; } }
        if (!resolved) { missingChild = true; break; }
        children.push(resolved);
      }
      if (missingChild) { intent.state = 'unknown'; this._halt(`Cover child history for ${intent.symbol} is unavailable. Its absence does not prove an exit; reconcile in Zerodha.`, 'order_unknown'); continue; }
      if (children.some(o => o.exchange !== 'NSE' || o.tradingsymbol !== intent.symbol || !['MIS', 'CO'].includes(o.product) || o.variety !== 'co' || String(o.parent_order_id) !== intent.order_id || o.transaction_type !== exitSide)) {
        intent.state = 'conflict'; this._halt(`Cover child identity for ${intent.symbol} changed; manual reconciliation required.`, 'ownership_conflict'); continue;
      }
      if([parent,...children].some(o=>!validBrokerFill(o))){
        intent.state='conflict';this._halt(`Invalid broker fill data for ${intent.symbol}; account reconciliation is required.`,'ownership_conflict');continue;
      }
      intent.broker_parent = jsonable(parent); intent.broker_children = jsonable(children); intent.broker_orders = [intent.broker_parent, ...intent.broker_children];
      const filled = Number(parent.filled_quantity || 0), sold = sum(children.map(o => Number(o.filled_quantity || 0)));
      if (sold > filled) { intent.state = 'conflict'; this._halt(`Cover exit fills exceed entry fills for ${intent.symbol}; account reconciliation is required.`, 'ownership_conflict'); continue; }
      const quantity = Math.max(0, filled - sold), entry = Number(parent.average_price || intent.entry); intent.filled = filled;
      let pnl = sum(children.map(o => direction*(Number(o.average_price || 0) - entry) * Number(o.filled_quantity || 0)));
      pnl -= (entry * sold + sum(children.map(o => Number(o.average_price || 0) * Number(o.filled_quantity || 0)))) * FEE_RATE;
      this.realised += pnl - (intent.pnl_accounted || 0); intent.pnl_accounted = pnl;
      const symbol = intent.symbol, activeChildren = children.filter(o => !TERMINAL.has(o.status));
      if (quantity) {
        this.positions[symbol] = { symbol, token: intent.token, strategy: 'intraday', setup:intent.setup, side, quantity, entry, stop: intent.stop, target: intent.target, tag, mode: 'live', last: this.quotes[intent.token]?.last_price ?? entry, entry_fee: entry * quantity * FEE_RATE, opened_at: intent.created_at, protection: activeChildren.length ? 'broker_cover' : 'unconfirmed' };
        const protectedQuantity = sum(activeChildren.map(o => Number(o.pending_quantity || 0)));
        const changedStop = activeChildren.some(o => !intent.exit_at && (!Number.isFinite(Number(o.trigger_price))||Number(o.trigger_price)<=0||direction*(Number(o.trigger_price)-Number(intent.stop)) < -.0001));
        if (protectedQuantity !== quantity || changedStop) { intent.state = 'unprotected'; this._halt(`Cover protection quantity or stop for ${symbol} differs from the journal; inspect Zerodha immediately.`, 'protection_missing'); }
        else intent.state = TERMINAL.has(parent.status) ? 'open' : 'pending';
        if (intent.exit_at && activeChildren.length) intent.state = 'exit_pending';
        const net = sum((this.account.positions?.net || []).filter(p => p.tradingsymbol === symbol && p.exchange === 'NSE' && ['MIS', 'CO'].includes(p.product)).map(p => Number(p.quantity || 0)));
        if (net !== direction*quantity) { intent.state = 'conflict'; this._halt(`Account quantity for ${symbol} differs from the bot journal (manual trade or reconciliation delay). Entries paused.`, 'ownership_conflict'); }
      } else if (TERMINAL.has(parent.status)) {
        if (activeChildren.some(o => Number(o.pending_quantity || 0) > 0)) { intent.state = 'conflict'; this._halt(`Cover child remains active without owned quantity for ${symbol}; inspect Zerodha.`, 'ownership_conflict'); continue; }
        delete this.positions[symbol]; intent.state = filled ? 'closed' : 'rejected'; this._event('intent_closed', `Broker intent resolved: ${symbol}.`, { tag, filled, pnl_estimated: pnl });
      } else intent.state = 'pending';
      const created = parseTime(intent.created_at);
      if (!TERMINAL.has(parent.status) && created && this._now() - created > 30000) await this._request_cancel_locked(intent, parent, null, 'entry_timeout');
      const exitAt = parseTime(intent.exit_at);
      if (exitAt && quantity && this._now() - exitAt > 30000) this._halt(`Exit for ${symbol} is still unresolved; inspect its broker cover order immediately.`, 'exit_pending');
    }
  }

  _holding_token(holding) {
    if (holding.exchange !== 'NSE') return 0;
    const token = Number(holding.instrument_token || 0), symbol = holding.tradingsymbol;
    if (this.universe[token] && (!symbol || this.universe[token].tradingsymbol === symbol)) return token;
    return Number(entries(this.universe).find(([, instrument]) => instrument.tradingsymbol === symbol)?.[0] || 0);
  }
  _holding_tokens() {
    const tokens = new Set((this.account.holdings || []).map(h => this._holding_token(h)).filter(Boolean));
    for (const p of values(this.positions)) if (p.strategy === 'swing') tokens.add(Number(p.token || 0));
    if (this.delivery) for (const p of values(this.delivery.snapshot().positions || {})) if (p.status !== 'closed') tokens.add(Number(p.token || 0));
    return tokens;
  }
  _priority_tokens(tokens, managed) {
    const turnover = t => Number(this.quotes[t]?.volume_traded || 0) * Number(this.quotes[t]?.last_price || 0);
    return tokens.sort((a, b) => Number(!managed.has(a)) - Number(!managed.has(b)) || turnover(b) - turnover(a));
  }
  _daily_history_bars(rows,today,minimum){
    if(!Array.isArray(rows))return [];
    const bars=[];
    for(const row of rows){
      if(!row||typeof row!=='object')return [];
      const at=parseTime(row.date??row.time);if(!at)return [];
      if(dateIST(at)>=today)continue; // An unfinished/current daily bar is not history.
      const fields=['open','high','low','close','volume'].map(key=>row[key]);
      if(!fields.every(Number.isFinite))return [];
      bars.push(new Candle(at,...fields));
    }
    if(bars.length<minimum||!validate_bars(bars,{interval:'swing'}).valid)return [];
    const latest=parseTime(dateIST(bars.at(-1).time)+'T00:00:00+05:30'),current=parseTime(today+'T00:00:00+05:30');
    if(current-latest>7*86400000||bars.slice(1).some((bar,index)=>Math.abs(bar.open/bars[index].close-1)>.2))return [];
    return bars;
  }
  _retry_daily_history(token){
    const attempts=Math.min(4,(this._daily_history_retry[token]?.attempts||0)+1);
    this._daily_history_retry[token]={attempts,next_at:monotonic()+Math.min(300,60*2**(attempts-1))};
  }
  _history_rate_wait(activity, error=null) {
    const health=this.broker?.rate_limit_health?.().categories?.find(item=>item.category==='historical'&&item.status==='cooldown');
    if (!health && error?.http_status!==429) return false;
    const delay=Math.max(1,Number(health?.retry_after_seconds||error?.retry_after_seconds)||30);
    activity({status:'waiting',message:'Zerodha historical-data rate limit (HTTP 429). Downloads are paused until the cooldown ends; cached history is retained.',next_retry_at:health?.retry_at||error?.retry_at||new Date(+this._now()+delay*1000).toISOString()});
    return true;
  }
  _history_progress_event(kind, progress) {
    const scope = `${dateIST(this._now())}:${this._universe_generation}`, signature = `${scope}:${progress.ready}:${progress.total}`;
    const previous = this._history_logged[kind], complete = progress.total > 0 && progress.ready === progress.total;
    if (previous?.signature === signature || previous?.scope === scope && monotonic()-previous.at < 300 && !complete) return;
    this._history_logged[kind] = {scope,signature,at:monotonic()};
    this._event(kind,`${kind==='daily_history'?'Daily':'Five-minute'} candle coverage: ${progress.ready} of ${progress.total} currently loaded. See Background for live progress and retries.`,progress);
  }
  async _history_pass(signal) {
    const config = this.strategy_settings(), today = dateIST(this._now()), holdingTokens = this._holding_tokens();
    const riskTokens=this.settings.correlation_filter?new Set([...this._correlation_wanted,...this._holding_tokens(),...values(this.positions).map(p=>Number(p.token))]):new Set();
    const wanted = this._priority_tokens(Object.keys(this.universe).map(Number).filter(t => config.swing_enabled || holdingTokens.has(t)||riskTokens.has(t)), new Set([...holdingTokens,...riskTokens]));
    const coverage = today + (config.swing_enabled ? ':all' : ':holdings:' + [...new Set([...holdingTokens,...riskTokens])].sort((a, b) => a - b).join(','));
    const activity=this._activity.begin('daily_history',{message:'Checking completed daily candle coverage.',total:wanted.length});
    if (!wanted.length || this._history_date === coverage || !this.connected) {
      activity({status:'waiting',completed:this._history_date===coverage?wanted.length:0,message:!this.connected?'Waiting for Zerodha connection.':!wanted.length?'No daily history is currently required for holdings, swing or correlation checks.':'Daily candle coverage is current. Waiting for the next session or scope change.'});return;
    }
    if(this._history_rate_wait(activity)){
      activity({completed:wanted.filter(token=>this._daily_history_bars(this.daily[token],today,holdingTokens.has(token)?21:55).length).length});return;
    }
    const broker = this.broker,generation=this._universe_generation;
    const valid=()=>this.connected&&!signal?.aborted&&!this._shutdown&&broker===this.broker&&generation===this._universe_generation&&dateIST(this._now())===today;
    let completed = 0, failed = 0, deferred = 0;
    let finished=false;
    try {
    for (const token of wanted) {
      if(!valid())return;
      const symbol=this.universe[token]?.tradingsymbol;if(!symbol)return;
      const currentIdentity=()=>valid()&&this.universe[token]?.tradingsymbol===symbol;
      const minimum=holdingTokens.has(token)?21:55;
      if(this._daily_history_bars(this.daily[token],today,minimum).length){completed++;activity({completed});continue;}
      if(monotonic()<(this._daily_history_retry[token]?.next_at||0)){deferred++;continue;}
      const cache = this.store.get(`daily:${token}`, {})||{};let downloaded=false;
      activity({message:`Checking cached daily candles for ${symbol}.`,current_item:symbol,completed,failed});
      try {
        let bars=cache.date===today&&cache.symbol===symbol?this._daily_history_bars(cache.rows,today,minimum):[];
        if(!bars.length){
          const end = parseTime(`${today}T00:00:00+05:30`);
          downloaded=true;
          activity({message:`Downloading daily candles for ${symbol}.`});
          const rows = await broker.call('historical_data', token, new Date(end - 160 * 86400000), new Date(end - 1000), 'day');
          if(!currentIdentity())return;
          bars=this._daily_history_bars(rows,today,minimum);
          if(bars.length)this.store.set(`daily:${token}`,{date:today,symbol,rows:jsonable(bars.map(({time,...fields})=>({date:time,...fields})))});
        }
        if(bars.length){
          this.daily[token] = bars; this._daily_checked.delete(token);
          delete this._daily_history_retry[token];completed++;
          if (monotonic() - (this.quotes[token]?.received_at ?? -Infinity) <= 10) this._queue_current_analysis(token);
        }else{delete this.daily[token];this._retry_daily_history(token);failed++;}
      } catch (exc) {
        if(!currentIdentity())return;
        if (!(exc instanceof BrokerError)) throw exc;
        if(this._history_rate_wait(activity,exc)){activity({completed,failed});finished=true;return;}
        failed++;this._retry_daily_history(token);
        if (exc.kind === 'TokenException') { this.connected = false; this._halt('Authentication expired while loading daily history. Reconnect Zerodha.', 'auth_expired', failureMetadata(exc, 'daily_history', 'download')); break; }
      }
      activity({completed,failed});
      if(downloaded)await sleep(100,signal);
    }
    if(!valid())return;
    this._history_failures = wanted.length-completed;
    this._history_date=this.connected&&completed===wanted.length?coverage:'';
    this._history_progress_event('daily_history',{ready:completed,failed,deferred,total:wanted.length});
    const retryTimes=wanted.map(t=>this._daily_history_retry[t]?.next_at).filter(Number.isFinite);
    activity({status:'waiting',completed,failed,message:completed===wanted.length?'Daily candle coverage is current.':`${completed} of ${wanted.length} symbols ready; incomplete or unavailable histories will be retried.`,next_retry_at:completed===wanted.length?null:new Date(+this._now()+Math.max(30000,retryTimes.length?(Math.min(...retryTimes)-monotonic())*1000:30000)).toISOString()});finished=true;
    } catch(error) {activity({status:'failed',message:'Daily candle loading failed; the background loop will retry.',failed:failed+1});finished=true;throw error;}
    finally {if(!finished)activity({status:this.connected?'waiting':'failed',completed,failed,message:this.connected?'Daily candle pass interrupted; waiting for a current account and universe.':'Daily candle loading stopped. Reconnect Zerodha to resume.'});}
  }
  async _history(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      try { await this._history_pass(signal); }
      catch (exc) { if (signal?.aborted || this._shutdown) return; const failure=failureMetadata(exc,'daily_history','download');this._event('daily_history_error', `Daily history unavailable (${failure.kind}); swing entries require complete data.`, failure, 'error'); }
      await sleep(30000, signal);
    }
  }
  _valid_intraday_seed(rows,today){
    if(!Array.isArray(rows)||rows.length<34||!validate_bars(rows,{interval:'intraday'}).valid)return false;
    const last=parseTime(rows.at(-1).time??rows.at(-1).date),priorDay=dateIST(last);
    const age=parseTime(today+'T00:00:00+05:30')-parseTime(priorDay+'T00:00:00+05:30');
    return priorDay<today&&age<=7*86400000&&timeIST(last)==='15:25';
  }
  _intraday_history_progress() {
    const date = dateIST(this._now()), universe = JSON.stringify(entries(this.universe).map(([token,i])=>[token,i.tradingsymbol]));
    if (!this._intraday_warmup || this._intraday_warmup.date !== date || this._intraday_warmup.universe !== universe)
      this._intraday_warmup = {date,universe,completed:new Set()};
    const progress = this._intraday_warmup;
    let ready = 0;
    for (const token of this._intraday_history_loaded) if (this.universe[token]) ready++;
    return {completed:progress.completed.size,total:count(this.universe),ready,progress_date:date,progress_kind:'session_warmup'};
  }
  async _intraday_history_pass(signal) {
    const update=this._activity.begin('intraday_history',{message:'Checking five-minute candle coverage.',...this._intraday_history_progress(),failed:this._intraday_history_failed});
    const activity=patch=>update({...patch,...this._intraday_history_progress()});
    if (!this.connected || !marketHours(this._now()) || !this.strategy_settings().intraday_enabled || !count(this.quotes)) {
      activity({status:'waiting',message:!this.connected?'Waiting for Zerodha connection.':!this.strategy_settings().intraday_enabled?'Intraday trading is disabled.':!marketHours(this._now())?'Waiting for market hours to load current-session candles.':this._clock_block()?'Waiting for system clock verification and fresh market prices.':'Waiting for fresh market prices.'});return;
    }
    if(this._history_rate_wait(activity))return;
    const today=dateIST(this._now());
    for(const [token,seed] of entries(this.previous_intraday))if(!this._valid_intraday_seed(seed,today)){
      delete this.previous_intraday[token];this._intraday_history_loaded.delete(Number(token));delete this._intraday_history_retry[token];
    }
    const managed = new Set(values(this.positions).map(p => Number(p.token))), wanted = this._priority_tokens(Object.keys(this.universe).map(Number).filter(t => !this._intraday_history_loaded.has(t)&&monotonic()>=(this._intraday_history_retry[t]||0)), managed);
    const broker = this.broker,generation=this._universe_generation;
    const valid=()=>this.connected&&!signal?.aborted&&!this._shutdown&&broker===this.broker&&generation===this._universe_generation&&dateIST(this._now())===today;
    let finished=false,stopped=false,rateLimited=false,passError=null,next=0;
    const active=new Set();
    const reportActive=()=>{
      if(!valid()||stopped)return;
      const names=[...active];
      activity({message:names.length?`Downloading five-minute candles for ${names.join(', ')}.`:'Checking five-minute candle coverage.',current_item:names.length?names.join(', '):null,failed:this._intraday_history_failed});
    };
    const download=async token=>{
      if(!valid()||!marketHours(this._now()))return;
      const symbol=this.universe[token]?.tradingsymbol;if(!symbol)return;
      const currentIdentity=()=>valid()&&this.universe[token]?.tradingsymbol===symbol;
      const now = this._now(), boundary = new Date(Math.floor(now.getTime() / 300000) * 300000), start = parseTime(`${dateIST(now)}T09:15:00+05:30`);
      if (boundary <= start) {stopped=true;return;}
      active.add(symbol);reportActive();
      try {
        const cache=this.store.get(`intraday_seed:${token}`,{})||{},needsSeed=this.settings.enhanced_signals===true;
        if(!this.previous_intraday[token]?.length&&cache.date===dateIST(now)&&cache.symbol===symbol&&this._valid_intraday_seed(cache.bars,dateIST(now)))this.previous_intraday[token]=cache.bars.map(b=>new Candle(b.time??b.date,...['open','high','low','close','volume'].map(k=>b[k])));
        const from=needsSeed&&!this.previous_intraday[token]?.length?new Date(+start-7*86400000):start;
        const rows = await broker.call('historical_data', token, from, new Date(boundary - 1000), '5minute', {signal,isCurrent:()=>!stopped&&currentIdentity()&&marketHours(this._now())});
        if(!currentIdentity())return;
        if(needsSeed&&!this.previous_intraday[token]?.length){
          const earlier=rows.filter(r=>{const at=parseTime(r.date??r.time);return at&&at<start&&at>=from;});
          const lastDate=earlier.length?dateIST(parseTime(earlier.at(-1).date??earlier.at(-1).time)):null;
          const source=earlier.filter(r=>dateIST(parseTime(r.date??r.time))===lastDate);
          if(this._valid_intraday_seed(source,dateIST(now))){
            const prior=source.map(r=>new Candle(r.date??r.time,...['open','high','low','close','volume'].map(k=>r[k])));
            this.previous_intraday[token]=prior;this.store.set(`intraday_seed:${token}`,{date:dateIST(now),symbol,bars:prior});
          }
        }
        this._seed_intraday(token, rows, boundary);
        const current=this.books[token]?.bars||[];
        const complete=current.length&&timeIST(current[0].time)==='09:15'&&+current.at(-1).time+300000===+boundary&&validate_bars(current,{interval:'intraday'}).valid;
        if(complete&&(!needsSeed||this.previous_intraday[token]?.length||current.length>=34)){
          this._intraday_history_loaded.add(token);delete this._intraday_history_retry[token];
          this._intraday_history_progress();this._intraday_warmup.completed.add(token);
        }
        else this._intraday_history_retry[token]=monotonic()+60;
      } catch (exc) {
        if(!currentIdentity())return;
        if(stopped&&exc.name==='AbortError')return;
        if (!(exc instanceof BrokerError)) throw exc;
        if(this._history_rate_wait(activity,exc)){rateLimited=true;stopped=true;return;}
        if(stopped)return;
        this._intraday_history_failed++;
        this._intraday_history_retry[token]=monotonic()+60;
        if (exc.kind === 'TokenException') { this.connected = false;stopped=true; this._halt('Authentication expired loading intraday history. Reconnect Zerodha.', 'auth_expired', failureMetadata(exc, 'intraday_history', 'download')); }
      } finally {
        active.delete(symbol);reportActive();
      }
      activity({failed:this._intraday_history_failed});
    };
    try {
    // Keep a small pipeline full. The shared broker schedules all historical
    // starts, including daily history and research, independently of responses.
    await Promise.all(Array.from({length:Math.min(HISTORICAL_CONCURRENCY,wanted.length)},async()=>{
      while(!stopped&&valid()&&marketHours(this._now())&&next<wanted.length){
        const token=wanted[next++];
        try{await download(token);}catch(error){stopped=true;passError??=error;}
      }
    }));
    if(passError)throw passError;
    if(rateLimited){activity({failed:this._intraday_history_failed});finished=true;return;}
    if(this.connected&&!valid())return;
    const remaining=count(this.universe)-this._intraday_history_loaded.size,retries=values(this._intraday_history_retry).filter(Number.isFinite);
    this._history_progress_event('intraday_history',{ready:this._intraday_history_loaded.size,total:count(this.universe),failed:this._intraday_history_failed});
    activity({status:this.connected?'waiting':'failed',failed:this._intraday_history_failed,message:!this.connected?'Five-minute candle loading stopped. Reconnect Zerodha to resume.':remaining?`${remaining} symbols still need complete candles; waiting for fresh data or retry. Current candles must close before use.`:'Historical warmup is complete. Live candles continue to build from market prices.',next_retry_at:this.connected&&remaining?new Date(+this._now()+Math.max(15000,retries.length?(Math.min(...retries)-monotonic())*1000:15000)).toISOString():null});finished=true;
    } catch(error) {activity({status:'failed',message:'Five-minute candle loading failed; the background loop will retry.',failed:this._intraday_history_failed+1});finished=true;throw error;}
    finally {if(!finished)activity({status:'waiting',message:'Candle loading paused; waiting for market hours and a current account/universe.'});}
  }
  async _intraday_history(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      try { await this._intraday_history_pass(signal); }
      catch (exc) { if (signal?.aborted || this._shutdown) return; const failure=failureMetadata(exc,'intraday_history','download');this._event('intraday_history_error', `Intraday warmup failed (${failure.kind}); observed candles remain available.`, failure, 'error'); }
      await sleep(this.connected && !count(this.quotes) ? 1000 : 15000, signal);
    }
  }
  _seed_intraday(token, rows, boundary) {
    const book = this.books[token]; if (!book) return;
    const merged = new Map(book.bars.map(b => [b.time.getTime(), b]));
    for (const row of rows) {
      const at = parseTime(row.date??row.time);
      if (!at || dateIST(at) !== dateIST(boundary) || at.getTime() + 300000 > boundary.getTime() || timeIST(at) < '09:15' || at.getUTCMinutes() % 5 || at.getUTCSeconds()) continue;
      const fields = ['open', 'high', 'low', 'close', 'volume'].map(k => Number(row[k]));
      if (!fields.every(Number.isFinite) || Math.min(...fields.slice(0, 4)) <= 0 || fields[4] < 0 || fields[1] < Math.max(fields[0], fields[3]) || fields[2] > Math.min(fields[0], fields[3])) continue;
      if (book.current && at >= book.current.time) continue;
      merged.set(at.getTime(), new Candle(at, ...fields));
    }
    book.bars = [...merged.entries()].sort(([a], [b]) => a - b).slice(-80).map(([, b]) => b); this._queue_current_analysis(Number(token));
  }
  _holding_signals() {
    const config = this._holding_management_settings(), selected = new Set(config.managed_symbols || []), results = [];
    for (const holding of this.account.holdings || []) {
      const symbol = holding.tradingsymbol || '', token = this._holding_token(holding), instrument = this.universe[token], quantity = Math.max(0, Number(holding.quantity || 0) - Number(holding.used_quantity || 0) - Number(holding.collateral_quantity || 0)), bars = this.daily[token] || [];
      const record = { symbol, exchange: holding.exchange, token, quantity, managed: selected.has(symbol), status: 'warming_up', reason: 'Waiting for at least 21 usable completed daily candles.', action: 'analysis_only' };
      results.push(record);
      if (config.manage_existing_holdings === 'ignore') {
        Object.assign(record, {managed:false,status:'ignored',action:'ignored',reason:'Ignored by your existing-holdings setting. Automatic buys and sells for this stock are disabled.'}); continue;
      }
      if (holding.exchange !== 'NSE' || (holding.product || 'CNC') !== 'CNC') {
        Object.assign(record, { managed: false, status: 'unsupported', reason: 'Automatic exit analysis supports NSE delivery holdings only.' }); continue;
      }
      if (!instrument) {
        const verified = this.universe_summary?.status === 'verified';
        Object.assign(record, { managed: false, status: verified ? 'unsupported' : 'universe_unavailable', reason: verified ? 'Outside the verified NSE stock and ETF universe; automatic exit analysis is unavailable for this holding.' : 'NSE stock and ETF eligibility is not verified yet; this holding cannot be analysed until its instrument is available.' }); continue;
      }
      if (instrument.entry_eligible === false || instrument.recovery_only) Object.assign(record, { scope: 'recovery_only', scope_reason: 'Existing managed exposure is monitored for exits only; new purchases and new holding adoption are disabled for this instrument.' });
      const analysis = this._analysis_cache.get(keyFor('swing', token)), research = analysis?.holding;
      const quote = this.quotes[token] || {}, fresh = monotonic() - (quote.received_at ?? -Infinity) <= 10;
      if (bars.length >= 21 && research) {
        const trailing = research.trailing, trendExit = research.trend_exit, stopExit = fresh && Number(quote.last_price || 0) <= trailing;
        Object.assign(record, { status: trendExit || stopExit ? 'exit_candidate' : 'hold', reason: trendExit ? 'Completed daily trend weakened.' : stopExit ? 'Daily ATR stop breached.' : 'Daily trend and ATR exit conditions not triggered.', trailing_reference: round(trailing) });
        if (!fresh) {
          if (!trendExit) Object.assign(record, { status: 'awaiting_market_data', reason: 'Completed daily trend has no exit signal. A fresh quote is required to check the ATR stop.' });
          else record.reason += ' A fresh executable quote is required before an exit.';
        }
      } else if (this._daily_history_retry[token]) {
        Object.assign(record, { status: 'history_unavailable', reason: 'No usable completed daily history for exit analysis. History refresh will retry automatically.' });
      } else if (bars.length >= 21 && analysis && !research) {
        Object.assign(record, { status: 'history_unavailable', reason: 'Completed daily candles did not produce usable exit analysis.' });
      } else if (bars.length >= 21) {
        Object.assign(record, { status: fresh ? 'analysing' : 'awaiting_market_data', reason: fresh ? 'Completed daily candles are ready; waiting for exit analysis.' : 'Completed daily candles are ready; waiting for a fresh market quote to start exit analysis.' });
      }
      if (this._paper_holding_actions[`${this.day}:${symbol}`] && this.mode === 'paper') record.action = 'simulated_sell';
    }
    return results;
  }
  _analyze_holdings() {
    const results = this._holding_signals();
    for (const record of results) {
      const { symbol, token, managed, quantity } = record, quote = this.quotes[token] || {}, key = `${this.day}:${symbol}`;
      const fresh = monotonic() - (quote.received_at ?? -Infinity) <= 10;
      if (this.mode === 'paper' && this.running && managed && quantity > 0 && record.status === 'exit_candidate' && fresh && !this._paper_holding_actions[key] && bidOf(quote) > 0) {
        const action = { ...record, action: 'simulated_sell', price: bidOf(quote) * .9995, time: isoIST(this._now()), note: 'Shadow holding exit; your actual holding is unchanged.' };
        this._paper_holding_actions[key] = action; this.store.set('paper_holding_actions', this._paper_holding_actions); this._event('paper_holding_exit', `Simulated exit of ${quantity} existing ${symbol} shares.`, action);
        record.action = 'simulated_sell';
      }
    }
    this.holdings_signals = results;
  }
  _background_snapshot() {
    const tasks=this._activity.snapshot(),analytics=tasks.find(task=>task.id==='analytics');
    Object.assign(tasks.find(task=>task.id==='intraday_history'),this._intraday_history_progress());
    const active=this._active_batches.size,pending=this._analysis_pending.size;
    Object.assign(analytics,{status:active?'running':this._shutdown?'stopped':this._last_analysis_error?'failed':'waiting',message:active?`Analyzing ${active} batches of completed candles; ${pending} symbol/strategy jobs queued.`:this._last_analysis_error|| (pending?`${pending} symbol/strategy jobs queued for workers.`:this.connected?'Waiting for completed candles or changed market context.':'Waiting for Zerodha connection.'),completed:this.analytics.completed_symbols||0,total:0,current_item:null,updated_at:this._last_analysis_at||analytics.updated_at});
    return {tasks};
  }
  snapshot() {
    const positions = values(this.positions).map(p => ({ ...p, side:sideOf(p), unrealised: round(markedProfit(p)) }));
    const pending = values(this.intents).some(i => !['closed', 'rejected'].includes(i.state)), delivery = this.delivery?.snapshot() || {}, deliveryBusy = values(delivery.positions || {}).some(p => p.status !== 'closed'), unrealised = this._unrealised();
    return jsonable({ mode: this.mode, status: this.status, entries_enabled:this.running, connected: this.connected, user_id: this.user_id, capital: this.capital, waiting_for_funds: this._waiting_for_funds(), broker_clock: this.broker?.clock_health?.() || null,api_limits:this.broker?.rate_limit_health?.()||null,
      equity: round(this.capital + this.realised - this._capital_accounted_pnl + unrealised), realised_pnl: round(this.realised), unrealised_pnl: round(unrealised), daily_pnl: round(this._daily_pnl()), pnl_fees_estimated: true,
      capital_source: this.mode === 'paper' ? 'persisted_paper_balance_seeded_from_broker_cash' : 'verified_broker_cash', broker_available_cash: this._broker_available_cash,
      risk_used: round(sum(values(this.positions).map(plannedRisk))), universe_count: count(this.universe), universe_classification:this.universe_summary,
      subscribed_count: sum(entries(this.streams).filter(([, ready]) => ready).map(([i]) => Math.min(3000, count(this.universe) - Number(i) * 3000))),
      warmed_count: entries(this.books).filter(([t,b]) => this._intraday_warmed(t,b)).length,prior_session_seed_count:count(this.previous_intraday),swing_warmed_count: count(this.daily), swing_history_failures: this._history_failures,
      heartbeat: this._heartbeat, market_open: marketHours(this._now()), feed_fresh: monotonic() - this._last_tick_received <= 10, account_fresh: monotonic() - this._account_at <= 45,
      positions, account: this.account, signals: this.signals, holdings_signals: this._holding_signals(), delivery, background:this._background_snapshot(),performance: {...this.analytics.snapshot(this._analysis_pending.size, this._analysis_cache.size),active_batches:[...this._active_batches.values()].slice(0,32),active_batch_count:this._active_batches.size},
      intents: values(this.intents).slice(-100), strategy_settings: this.strategy_settings(), pending_orders: [...values(this.intents).filter(i => !['closed', 'rejected', 'open'].includes(i.state)), ...values(delivery.positions || {}).filter(p => p.status !== 'closed')],
      safe_to_stop: !this._other_mode_live_risk() && (this.mode !== 'live' || (!positions.length && !pending && !deliveryBusy && !this.running)), unmanaged_live_exposure: this._other_mode_live_risk(),
      message: this.message, error: this.error, error_help:this.error?this.error_help:null, recovery: { ...this.recovery }, readiness:this.readiness(),live_swing_supported: true, decision_controls:this._decision_controls(),
      limitations: ['Strategies are unvalidated research rules, not proven profitable models.', 'Paper fills include a 0.05% price adjustment and estimated 0.1% fees per side.', 'New swing buys require DDPI/POA; existing holding sales can request current-day CDSL authorization. GTT limits do not guarantee fills through gaps or circuits.', 'Exchange holidays are inferred from fresh market data; no holiday calendar is assumed.'] });
  }
}
