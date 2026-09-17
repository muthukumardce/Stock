/** Persistent NSE scanner and serialized, journalled paper/live execution.
 * An ambiguous broker mutation is never automatically retried. Recovery verifies
 * actual broker exposure before admitting new decisions from fresh candles.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KiteBroker, BrokerError, jsonable } from './broker.js';
import { AnalyticsPool } from './analytics.js';
import { DeliveryManager } from './delivery.js';
import { HoldingsAuthorization } from './holdings-authorization.js';
import { Candle, CandleBook, Signal, position_size } from './strategy.js';
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
const unresolved = new Set(['submitting', 'unknown', 'conflict', 'unprotected', 'exit_unknown', 'exit_pending']);

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
    this.account = store.get('account_snapshot', { margins: {}, holdings: [], positions: {}, orders: [], trades: [] });
    this._account_at = -Infinity; this._heartbeat = null; this._tasks = []; this._retiringTasks = [];
    this._lock = new Mutex(); this._candidates = []; this.signals = []; this._stats = {};
    this._last_summary = 0; this._last_persist = 0; this._reconcile_requested = false;
    this._wakeMonitor = null; this._controller = null;
    this._order_seen = {}; this._trade_seen = new Set(); this._position_seen = null;
    this._holdings_seen = null; this._balance_seen = null; this._balance_logged_at = 0;
    this.daily = {}; this._daily_checked = new Set(); this._history_date = ''; this._history_failures = 0;
    this._shutdown = false; this._last_tick_received = -Infinity; this._risk_halted = false;
    this.holdings_signals = []; this._paper_holding_actions = store.get('paper_holding_actions', {});
    this._last_holdings_scan = 0; this._intraday_history_loaded = new Set(); this._intraday_history_failed = 0;
    this.analytics = options.analyticsFactory ? options.analyticsFactory(settings) : new AnalyticsPool(settings.analytics_workers || 0, settings.analytics_reserve_cpus ?? 4, settings.analytics_batch_size || 32);
    this._analysis_pending = new Map(); this._analysis_tasks = new Set(); this._analysis_cache = new Map(); this._analysis_generation = 0;
    this._profile_verified = false; this._recovery_account_verified = false; this._recovery_holdings_checked = false;
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
      capital: this.capital, capital_accounted_pnl: this._capital_accounted_pnl }));
  }
  _halt(message, kind = 'risk_halt') {
    if (this.error !== message) this._event(kind, message, null, 'error');
    this.running = false; this.status = 'error'; this.error = this.message = message;
    if (this._unresolved_intents()) Object.assign(this.recovery, { phase: 'blocked', message, blocked: true, completed_at: null });
  }
  _maintenance() { return existsSync(join(this.settings.data_dir, 'maintenance.lock')); }
  _other_mode_live_risk() {
    if (this.mode === 'live') return false;
    const saved = this.store.get('bot_state_live', {}), delivery = this.store.get('delivery_state', {});
    return Boolean(count(saved.positions || {}) || values(saved.intents || {}).some(i => !['closed', 'rejected'].includes(i.state)) || values(delivery.positions || {}).some(p => p.status !== 'closed'));
  }
  _invalidate_decisions() {
    this._analysis_generation++; this._analysis_pending.clear(); this._analysis_cache.clear(); this._daily_checked.clear(); this._candidates = [];
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
  _authorized_holdings() {
    const config = this.strategy_settings(), selected = new Set(config.managed_symbols || []);
    return (this.account.holdings || []).filter(h => h.exchange === 'NSE' && (h.product || 'CNC') === 'CNC' && !h.discrepancy && Number(h.quantity || 0) - Number(h.used_quantity || 0) - Number(h.collateral_quantity || 0) > 0 && (config.manage_existing_holdings === 'all' || selected.has(h.tradingsymbol)));
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

  async connect(access_token, user_id) {
    return this._lock.run(async () => {
      if (this.user_id && this.user_id !== user_id) throw new Error('This data directory belongs to a different Zerodha account.');
      if (this.settings.kite_user_id && this.settings.kite_user_id !== user_id) throw new Error('The Zerodha account does not match KITE_USER_ID.');
      await this._stop_tasks();
      this.running = false; this.connected = false; this._profile_verified = false; this._account_at = -Infinity;
      this._begin_recovery(); this._roll_day(); this.daily = {}; this._history_date = ''; this.books = {}; this.quotes = {}; this.streams = {};
      this._last_tick_received = -Infinity; this._heartbeat = null;
      if (this.broker) await this.broker.close();
      this.broker = this._brokerFactory(this.settings.kite_api_key, access_token);
      if (this.delivery) this.delivery.broker = this.broker;
      this.user_id = user_id; this.running = false; this._shutdown = false;
      try {
        const profile = await this.broker.call('profile');
        if (String(profile.user_id || '').toUpperCase() !== String(user_id).toUpperCase()) throw new Error('Broker profile belongs to another account');
        this._profile = profile;this._profile_verified = true; await this._refresh_account_locked({ rebase_capital: true });
        const instruments = await this.broker.call('instruments', 'NSE');
        this.universe = Object.fromEntries(instruments.filter(i => i.exchange === 'NSE' && i.segment === 'NSE' && i.instrument_type === 'EQ').map(i => [Number(i.instrument_token), i]));
        if (!count(this.universe) || count(this.universe) > 9000) throw new Error('NSE universe is empty or exceeds streaming capacity; entries blocked.');
        const tokens = Object.fromEntries(entries(this.universe).map(([t, i]) => [i.tradingsymbol, Number(t)]));
        for (const [symbol, position] of entries(this.positions)) position.token = tokens[symbol] || 0;
        for (const intent of values(this.intents)) intent.token = tokens[intent.symbol] || 0;
        if (this.delivery) this.delivery.remap_tokens(tokens);
        this.books = Object.fromEntries(Object.keys(this.universe).map(t => [t, new CandleBook()]));
        this.quotes = {}; this.streams = {}; this._intraday_history_loaded.clear(); this._candidates = []; this.connected = true;
        if (!this._unresolved_intents()) { this.status = 'monitoring'; this.error = null; this.message = 'Monitoring Zerodha. Intraday warms from 21 complete five-minute candles.'; }
        this._advance_recovery();
        const activeBroker = this.broker;
        await this.broker.stream(Object.keys(this.universe).map(Number), ticks => { if (this.broker === activeBroker) this._on_ticks(ticks); }, order => { if (this.broker === activeBroker) this._on_order(order); }, (...args) => { if (this.broker === activeBroker) this._on_stream(...args); });
        if (this._backgroundLoops) this._start_tasks();
        this._event('connected', 'Zerodha account connected; entries remain paused.', { user_id, universe_count: count(this.universe), mode: this.mode });
        this._event('analytics_capacity', 'Parallel analytics ready; order execution remains serial.', this.analytics.snapshot()); this._persist();
      } catch (exc) {
        this.connected = false; this._halt(`Connection setup failed (${exc.name || 'Error'}). Verify Kite API access and reconnect.`, 'connection_error');
        Object.assign(this.recovery, { phase: 'blocked', message: this.message, blocked: true });
        if (this.broker) await this.broker.close();
        throw new Error(this.message);
      }
    });
  }

  async start() {
    return this._lock.run(async () => {
      if (this._maintenance()) throw new Error('Maintenance is active; trading cannot start.');
      if (this._other_mode_live_risk()) throw new Error('Unresolved real-money exposure exists from live mode. Restore live configuration and reconcile before using paper mode.');
      if (!this.connected || !this.broker) throw new Error('Connect Zerodha before starting trading.');
      const config = this.strategy_settings();
      if (!config.intraday_enabled && !config.swing_enabled) throw new Error('Enable at least one strategy in Settings.');
      const allocations = ['intraday', 'swing'].map(s => Number(config[`${s}_allocation_pct`] ?? 0));
      if (allocations.some(c => !Number.isFinite(c) || c < 0) || sum(allocations) > 1.0000001) throw new Error('Saved strategy allocations exceed available capital. Update Settings before starting.');
      if (['intraday', 'swing'].some(s => config[`${s}_enabled`] && Number(config[`${s}_allocation_pct`] || 0) <= 0)) throw new Error('Every enabled strategy needs a positive allocation.');
      if (this.mode === 'live' && !this.settings.live_trading_enabled) throw new Error('Live trading must be enabled in Settings.');
      this.running = false; this._begin_recovery(); this._roll_day(); await this._refresh_account_locked({ rebase_capital: true });
      if (this._unresolved_intents()) { this._advance_recovery(); throw new Error('An order or exit is unresolved. Reconcile it in Zerodha before restarting.'); }
      if (this.capital <= 0 && !this._has_managed_or_authorized_exposure()) throw new Error('Zerodha has no verified available cash for trading. Add funds or select eligible existing holdings to manage.');
      if (this.capital > 0 && this._daily_pnl() <= -this.capital * this.settings.daily_loss_pct) throw new Error('The daily loss limit has been reached.');
      if (this._maintenance()) throw new Error('Maintenance began during account reconciliation; trading remains paused.');
      this.running = true; this.status = 'running'; this.error = null;
      this.message = this.capital > 0 ? 'Strategies armed. Entries wait for market hours, fresh data and all risk checks.' : 'Holding management armed. New buys remain blocked until verified trading cash is available.';
      this._event('trading_started', 'Trading enabled.', { mode: this.mode, strategies: this.strategy_settings() }); this._advance_recovery();
      for (const token of Object.keys(this.universe)) if (monotonic() - (this.quotes[token]?.received_at ?? -Infinity) <= 10) this._queue_current_analysis(Number(token));
    });
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
    const scope=new Set(this._authorized_holdings().map(h=>h.tradingsymbol));
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
    this._tasks = ['_run', '_monitor', '_history', '_intraday_history', '_analysis_loop'].map(method => this[method](signal).catch(error => {
      if (!signal.aborted && !this._shutdown) this._halt(`Background task failed (${error.name || 'Error'}); entries paused.`, 'engine_error');
    }));
  }
  async _stop_tasks() {
    this._controller?.abort(); this._wakeMonitor?.(); this._wakeMonitor = null;
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
    const now = this._now(); if (!marketHours(now)) return;
    for (let tick of ticks) {
      const token = Number(tick.instrument_token || 0); if (!(token in this.universe)) continue;
      const at = parseTime(tick.exchange_timestamp), price = Number(tick.last_price || 0);
      if (!at || Math.abs(now - at) > 10000 || !Number.isFinite(price) || price <= 0) continue;
      tick = { ...tick, received_at: monotonic() }; this.quotes[token] = tick; this._last_tick_received = monotonic(); this._heartbeat = isoIST(now);
      const symbol = this.universe[token].tradingsymbol; if (this.positions[symbol]) this.positions[symbol].last = price;
      const previous = this.books[token].bars.length, closed = this.books[token].update(at, price, Number(tick.volume_traded || 0));
      if (previous && !this.books[token].bars.length) this._intraday_history_loaded.delete(token);
      if (closed) this._queue_analysis(token, 'intraday', this.books[token].bars);
      if (this.daily[token] && !this._daily_checked.has(token)) { this._daily_checked.add(token); this._queue_analysis(token, 'swing', this.daily[token]); }
    }
  }
  _queue_analysis(token, strategy, bars) {
    if (!bars.length) return;
    this._analysis_pending.set(keyFor(strategy, token), { token: Number(token), strategy, bars: [...bars], bar_time: isoIST(bars.at(-1).time), generation: this._analysis_generation, queued_at: monotonic() });
  }
  _queue_current_analysis(token) {
    const now = this._now(), bars = this.books[token]?.bars || [], last = bars.at(-1);
    if (last && dateIST(last.time) === dateIST(now) && now - last.time - 300000 >= 0 && now - last.time - 300000 < 300000) this._queue_analysis(token, 'intraday', bars);
    if (this.daily[token]) { this._daily_checked.add(Number(token)); this._queue_analysis(token, 'swing', this.daily[token]); }
  }
  async _analysis_loop(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      while (this._analysis_pending.size && this._analysis_tasks.size < this.analytics.worker_limit) {
        const batch = [...this._analysis_pending.keys()].slice(0, this.analytics.batch_size).map(key => { const job = this._analysis_pending.get(key); this._analysis_pending.delete(key); return job; });
        let task;
        task = Promise.resolve().then(() => this.analytics.analyze(batch)).then(results => this._analysis_finished(results)).catch(exc => {
          if (!signal?.aborted && !this._shutdown) this._halt(`Parallel analytics failed (${exc.name || 'Error'}); entries paused while monitoring and exits continue.`, 'analytics_error');
        }).finally(() => this._analysis_tasks.delete(task));
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
      this._analysis_cache.set(keyFor(strategy, token), result);
      const stat = `${strategy}:${result.reason}`; this._stats[stat] = (this._stats[stat] || 0) + 1;
      if (result.signal) this._candidate(token, new Signal(result.signal.strategy, result.signal.reference, result.signal.stop, result.signal.target, result.signal.reason, result.signal.score), result.metrics);
    }
  }
  _candidate(token, signal, metrics = {}) {
    const record = { time: isoIST(this._now()), symbol: this.universe[token].tradingsymbol, ...signal, status: 'candidate', analytics: metrics || {} };
    this.signals.unshift(record); this.signals.length = Math.min(60, this.signals.length);
    this._event('signal', `${record.symbol}: ${signal.reason}`, record);
    this._candidates.push([Number(token), signal, monotonic(), record]); if (this._candidates.length > 200) this._candidates.shift();
  }

  async _run_once() {
    this._roll_day(); const now = this._now();
    if (this.connected && marketHours(now)) {
      for (const [symbol, position] of entries(this.positions)) {
        const quote = this.quotes[position.token] || {}, fresh = monotonic() - (quote.received_at ?? -Infinity) <= 10, opened = parseTime(position.opened_at);
        const overdue = opened && dateIST(opened) < dateIST(now);
        if (position.strategy === 'intraday' && (timeIST(now) >= this.settings.exit_time || overdue)) await this._exit_locked(symbol, overdue ? 'overdue_intraday_exit' : 'intraday_session_exit');
        else if (fresh) {
          const last = Number(quote.last_price);
          if (last <= position.stop) await this._exit_locked(symbol, 'stop_loss');
          else if (last >= position.target) await this._exit_locked(symbol, 'profit_target');
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
          outcome = await this.delivery.evaluate_holdings(bars, this.strategy_settings(), quotes, { adopt_new: this.running });
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
    for (let left = Math.min(10, this._candidates.length); left > 0; left--) {
      const [token, signal, received, record] = this._candidates.shift();
      if (monotonic() - received <= 30) {
        const reason = await this._enter_locked(token, signal); record.status = reason;
        this._event('decision', `${record.symbol}: ${reason}`, { symbol: record.symbol, strategy: signal.strategy, decision: reason });
      }
    }
    if (monotonic() - this._last_summary >= 300 && count(this._stats)) { this._event('scan_summary', 'Closed-candle scan summary.', { ...this._stats }); this._stats = {}; this._last_summary = monotonic(); }
    if (monotonic() - this._last_persist >= 15) { this._persist(); this._last_persist = monotonic(); }
  }
  async _run(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      try {
        await this._lock.run(async () => { if (!signal?.aborted && !this._shutdown) await this._run_once(); });
        await sleep(1000, signal);
      } catch (exc) {
        if (signal?.aborted || this._shutdown) return;
        this._halt(`Trading loop interrupted (${exc.name || 'Error'}); entries paused.`, 'engine_error'); await sleep(2000, signal);
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
      try {
        this._reconcile_requested = false;
        await this._lock.run(async () => { if (!signal?.aborted && !this._shutdown) await this._refresh_account_locked(); });
        await this._wait_reconciliation(signal);
      } catch (exc) {
        if (signal?.aborted || this._shutdown) return;
        if (exc instanceof BrokerError && exc.kind === 'TokenException') {
          this.connected = false; this._halt('Zerodha authentication expired. Reconnect immediately; existing broker cover stops remain subject to broker execution.', 'auth_expired');
        } else this._halt(`Account monitoring interrupted (${exc.name || 'Error'}); entries paused until reconciliation recovers.`, 'account_error');
        await sleep(15000, signal);
      }
    }
  }
  async _refresh_account_locked({ rebase_capital = false, authorization_user_confirmed=false, reconcile_positions=true } = {}) {
    const account = await this.broker.account();
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
    if(this.mode==='live'&&this.holdings_authorization.snapshot().required){
      this._profile=await this.broker.call('profile');this._reconcile_authorization(this._profile,{userConfirmed:authorization_user_confirmed});
    }
    // Authorization controls only verify broker data. Ordinary engine monitoring
    // owns position reconciliation, which can modify protective orders.
    if (this.mode === 'live' && reconcile_positions) { await this._reconcile_live_locked(); await this.delivery.reconcile(account); this._sync_delivery(); }
    this._update_capital(rebase_capital);
    if (this.mode !== 'live' || reconcile_positions) this._recovery_account_verified = true;
    this._persist();
  }
  _available_cash() {
    const margin = this.account.margins?.equity || {}, available = margin.available || {};
    const fields = [available.cash ?? 0, available.live_balance ?? margin.net ?? 0, available.collateral ?? 0, available.adhoc_margin ?? 0].map(Number);
    if (!fields.every(Number.isFinite)) return 0;
    return Math.max(0, Math.min(fields[0], fields[1] - fields[2] - fields[3]));
  }
  _update_capital(rebase = false) {
    this._broker_available_cash = this._available_cash();
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
    this.books = Object.fromEntries(Object.keys(this.universe).map(t => [t, new CandleBook()])); this.quotes = {}; this.daily = {}; this._history_date = ''; this._recovery_holdings_checked = false;
    Object.assign(this.recovery, { phase: 'warming_up', message: 'New session: refresh market data and select Start Trading after Zerodha authentication.', blocked: true, completed_at: null });
    this._order_seen = {}; this._trade_seen.clear(); this.running = false;
    this._event('day_rollover', 'New trading day. Daily risk baseline reset; Start Trading is required again.'); this.status = this.connected ? 'paused' : 'disconnected'; this._persist();
  }
  _unrealised() { return sum(values(this.positions).map(p => ((p.last ?? p.entry) - p.entry) * p.quantity - (p.entry_fee || 0))); }
  _daily_pnl() { return this.realised - this.day_baseline + this._unrealised() - this.day_open_unrealised; }
  _exposure(strategy = null) {
    const positions = sum(values(this.positions).filter(p => strategy === null || p.strategy === strategy).map(p => p.entry * p.quantity));
    const pending = sum(values(this.intents).filter(i => ['submitting', 'unknown', 'pending'].includes(i.state) && (strategy === null || i.strategy === strategy)).map(i => i.entry * Math.max(0, i.quantity - (i.filled || 0))));
    const delivery = this.delivery && (strategy === null || strategy === 'swing') ? sum(values(this.delivery.snapshot().positions || {}).filter(p => p.source === 'swing' && p.status !== 'closed').map(p => Number(p.entry_price || 0) * Math.max(0, Number(p.requested_quantity || 0) - Number(p.quantity || 0)))) : 0;
    return positions + pending + delivery;
  }

  async _enter_locked(token, signal) {
    if (!this.running) return 'entries_paused';
    if (this._maintenance()) { this.running = false; return 'maintenance_active'; }
    const now = this._now();
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
    if (this._daily_pnl() <= -this.capital * this.settings.daily_loss_pct) return 'daily_loss_limit';
    const symbol = this.universe[token].tradingsymbol;
    if (this.positions[symbol] || this.traded.has(symbol) || values(this.intents).some(i => i.symbol === symbol && !['closed', 'rejected'].includes(i.state))) return 'already_owned_or_traded_today';
    const pendingCount = values(this.intents).filter(i => ['submitting', 'unknown', 'pending'].includes(i.state) && !this.positions[i.symbol]).length;
    if (count(this.positions) + pendingCount >= this.settings.max_positions) return 'maximum_positions';
    const quote = this.quotes[token] || {}; if (monotonic() - (quote.received_at ?? -Infinity) > 10) return 'quote_stale';
    const buys = quote.depth?.buy || [], sells = quote.depth?.sell || [];
    if (!buys.length || !sells.length || !(buys[0].price > 0) || !(sells[0].price > 0)) return 'market_depth_missing';
    const bid = Number(buys[0].price), ask = Number(sells[0].price);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid || (ask - bid) / ask > this.settings.max_spread_pct) return 'spread_too_wide';
    if (Number(quote.volume_traded || 0) * Number(quote.last_price || 0) < this.settings.min_daily_turnover) return 'turnover_too_low';
    if (Math.abs(ask / signal.reference - 1) > (signal.strategy === 'intraday' ? .005 : .02)) return 'price_moved_from_signal';
    const tick_size = Number(this.universe[token].tick_size || .05), entry = round(Math.ceil(ask * 1.0005 / tick_size) * tick_size, 4), stop = round(Math.floor(signal.stop / tick_size) * tick_size, 4);
    let remaining = Math.min(allocation - this._exposure(signal.strategy), this.capital + Math.min(0, this.realised - this._capital_accounted_pnl) - this._exposure());
    if (this.mode === 'live') {
      if (!this.settings.live_trading_enabled) return 'live_execution_disabled';
      if (this._account_symbol_busy(symbol)) return 'existing_account_exposure';
      remaining = Math.min(remaining, Math.max(0, this._available_cash() - this._exposure()));
    }
    const quantity = position_size(allocation, remaining, entry, stop, this.settings.risk_per_trade_pct, this.settings.max_position_pct);
    if (quantity < 1) return 'insufficient_risk_or_cash_budget';
    if (Number(sells[0].quantity || 0) < quantity) return 'insufficient_visible_liquidity';
    let riskUsed = sum(values(this.positions).map(p => Math.max(0, p.entry - p.stop) * p.quantity));
    riskUsed += sum(values(this.intents).filter(i => ['submitting', 'pending', 'unknown'].includes(i.state)).map(i => (i.entry - i.stop) * Math.max(0, i.quantity - (i.filled || 0))));
    if (riskUsed + (entry - stop) * quantity > this.capital * this.settings.daily_loss_pct) return 'aggregate_risk_limit';
    if (this._maintenance() || !this.running) return 'entries_paused';
    if (this.mode === 'paper') {
      this.positions[symbol] = { symbol, token: Number(token), strategy: signal.strategy, quantity, entry, last: Number(quote.last_price), stop, target: signal.target, entry_fee: entry * quantity * FEE_RATE, opened_at: isoIST(now), protection: 'simulated', mode: 'paper' };
      this.traded.add(symbol); this._persist(); this._event('paper_fill', `Simulated BUY ${quantity} ${symbol} at ${entry.toFixed(2)}.`, this.positions[symbol]); return 'paper_buy_filled';
    }
    if (signal.strategy === 'swing') {
      const result = await this.delivery.submit_entry(symbol, quantity, entry, stop, signal.target, tick_size, Number(token));
      if (result.position) this.traded.add(symbol);
      this._sync_delivery(); this._persist(); this.request_reconciliation(); return `delivery_${result.status || 'unknown'}${result.reason ? ': ' + result.reason : ''}`;
    }
    const tag = 'EB' + randomUUID().replaceAll('-', '').slice(0, 18);
    const intent = { tag, symbol, token: Number(token), strategy: signal.strategy, quantity, entry, stop, target: signal.target, created_at: isoIST(now), state: 'submitting', filled: 0, exit_requested: [], pnl_accounted: 0 };
    this.intents[tag] = intent; this.traded.add(symbol); this._persist();
    this._event('order_intent', `Submitting protected cover BUY ${quantity} ${symbol}.`, intent);
    try { intent.order_id = String(await this.broker.buy_cover(symbol, quantity, entry, stop, tag)); intent.state = 'pending'; }
    catch (exc) {
      if (exc instanceof BrokerError && ['InputException', 'PermissionException', 'TokenException'].includes(exc.kind)) {
        intent.state = 'rejected'; this._event('order_rejected', `Cover entry rejected before acknowledgement: ${symbol}.`, { tag, kind: exc.kind, detail: exc.detail }, 'error');
        if (['PermissionException', 'TokenException'].includes(exc.kind)) { if (exc.kind === 'TokenException') this.connected = false; this._halt('Broker authentication or trading permission rejected the entry. Reconnect or correct account permissions.'); }
      } else { intent.state = 'unknown'; this._halt(`Order acknowledgement unknown for ${symbol}; never retried automatically. Reconcile in Zerodha.`, 'order_unknown'); }
    }
    this._persist(); this.request_reconciliation(); return `cover_order_${intent.state}`;
  }
  _account_symbol_busy(symbol) {
    return (this.account.positions?.net || []).some(p => p.tradingsymbol === symbol && Number(p.quantity || 0) !== 0) || (this.account.holdings || []).some(p => p.tradingsymbol === symbol && Number(p.quantity || 0) + Number(p.t1_quantity || 0) > 0) || (this.account.orders || []).some(o => o.tradingsymbol === symbol && !TERMINAL.has(o.status));
  }
  async _exit_locked(symbol, reason) {
    const position = this.positions[symbol]; if (!position) return;
    if (this.mode === 'paper') {
      const quote = this.quotes[position.token] || {};
      if (!marketHours(this._now()) || monotonic() - (quote.received_at ?? -Infinity) > 10 || bidOf(quote) <= 0) return;
      const exit = bidOf(quote) * .9995, pnl = (exit - position.entry) * position.quantity - (position.entry_fee || 0) - exit * position.quantity * FEE_RATE;
      this.realised += pnl; delete this.positions[symbol]; this._persist(); this._event('paper_fill', `Simulated SELL ${position.quantity} ${symbol}: ${reason}.`, { ...position, exit, pnl, reason, fees_estimated: true }); return;
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
      const matches = orders.filter(o => (o.tag === tag || (o.tags || []).includes(tag)) && !o.parent_order_id);
      if (matches.length > 1) { intent.state = 'conflict'; this._halt(`Multiple broker orders match intent ${tag}; manual reconciliation required.`); continue; }
      let parent = byId[intent.order_id] || matches[0];
      if (!parent && intent.order_id) {
        try { parent = (await this.broker.call('order_history', intent.order_id)).at(-1); } catch { parent = null; }
        if (!parent && TERMINAL.has(intent.broker_parent?.status)) parent = intent.broker_parent;
      }
      if (!parent) { intent.state = 'unknown'; this._halt(`Unresolved order intent for ${intent.symbol}; no automatic resubmission.`); continue; }
      intent.order_id = String(parent.order_id);
      if (parent.variety !== 'co' || parent.transaction_type !== 'BUY' || parent.exchange !== 'NSE' || parent.tradingsymbol !== intent.symbol || !['MIS', 'CO'].includes(parent.product) || Number(parent.quantity ?? -1) !== Number(intent.quantity)) {
        intent.state = 'conflict'; this._halt('Broker order does not match protected long-only ownership journal.'); continue;
      }
      const children = orders.filter(o => String(o.parent_order_id) === intent.order_id); let missingChild = false;
      for (const prior of intent.broker_children || []) {
        if (children.some(o => String(o.order_id) === String(prior.order_id))) continue;
        let resolved = TERMINAL.has(prior.status) ? prior : null;
        if (!resolved) { try { resolved = (await this.broker.call('order_history', String(prior.order_id))).at(-1); } catch { resolved = null; } }
        if (!resolved) { missingChild = true; break; }
        children.push(resolved);
      }
      if (missingChild) { intent.state = 'unknown'; this._halt(`Cover child history for ${intent.symbol} is unavailable. Its absence does not prove an exit; reconcile in Zerodha.`, 'order_unknown'); continue; }
      if (children.some(o => o.exchange !== 'NSE' || o.tradingsymbol !== intent.symbol || !['MIS', 'CO'].includes(o.product) || o.variety !== 'co' || String(o.parent_order_id) !== intent.order_id || o.transaction_type !== 'SELL')) {
        intent.state = 'conflict'; this._halt(`Cover child identity for ${intent.symbol} changed; manual reconciliation required.`, 'ownership_conflict'); continue;
      }
      intent.broker_parent = jsonable(parent); intent.broker_children = jsonable(children); intent.broker_orders = [intent.broker_parent, ...intent.broker_children];
      const filled = Number(parent.filled_quantity || 0), sold = sum(children.filter(o => o.transaction_type === 'SELL').map(o => Number(o.filled_quantity || 0)));
      if (sold > filled) { intent.state = 'conflict'; this._halt(`Cover exit fills exceed entry fills for ${intent.symbol}; account reconciliation is required.`, 'ownership_conflict'); continue; }
      const quantity = Math.max(0, filled - sold), entry = Number(parent.average_price || intent.entry); intent.filled = filled;
      let pnl = sum(children.filter(o => o.transaction_type === 'SELL').map(o => (Number(o.average_price || 0) - entry) * Number(o.filled_quantity || 0)));
      pnl -= (entry * sold + sum(children.map(o => Number(o.average_price || 0) * Number(o.filled_quantity || 0)))) * FEE_RATE;
      this.realised += pnl - (intent.pnl_accounted || 0); intent.pnl_accounted = pnl;
      const symbol = intent.symbol, activeChildren = children.filter(o => !TERMINAL.has(o.status));
      if (quantity) {
        this.positions[symbol] = { symbol, token: intent.token, strategy: 'intraday', quantity, entry, stop: intent.stop, target: intent.target, tag, mode: 'live', last: this.quotes[intent.token]?.last_price ?? entry, entry_fee: entry * quantity * FEE_RATE, opened_at: intent.created_at, protection: activeChildren.length ? 'broker_cover' : 'unconfirmed' };
        const protectedQuantity = sum(activeChildren.filter(o => o.transaction_type === 'SELL').map(o => Number(o.pending_quantity || 0)));
        const changedStop = activeChildren.some(o => !intent.exit_at && Number(o.trigger_price || 0) + .0001 < Number(intent.stop));
        if (protectedQuantity !== quantity || changedStop) { intent.state = 'unprotected'; this._halt(`Cover protection quantity or stop for ${symbol} differs from the journal; inspect Zerodha immediately.`, 'protection_missing'); }
        else intent.state = TERMINAL.has(parent.status) ? 'open' : 'pending';
        if (intent.exit_at && activeChildren.length) intent.state = 'exit_pending';
        const net = sum((this.account.positions?.net || []).filter(p => p.tradingsymbol === symbol && p.exchange === 'NSE' && ['MIS', 'CO'].includes(p.product)).map(p => Number(p.quantity || 0)));
        if (net !== quantity) { intent.state = 'conflict'; this._halt(`Account quantity for ${symbol} differs from the bot journal (manual trade or reconciliation delay). Entries paused.`, 'ownership_conflict'); }
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

  _holding_tokens() {
    const tokens = new Set((this.account.holdings || []).filter(h => h.exchange === 'NSE').map(h => Number(h.instrument_token || 0)));
    for (const p of values(this.positions)) if (p.strategy === 'swing') tokens.add(Number(p.token || 0));
    if (this.delivery) for (const p of values(this.delivery.snapshot().positions || {})) if (p.status !== 'closed') tokens.add(Number(p.token || 0));
    return tokens;
  }
  _priority_tokens(tokens, managed) {
    const turnover = t => Number(this.quotes[t]?.volume_traded || 0) * Number(this.quotes[t]?.last_price || 0);
    return tokens.sort((a, b) => Number(!managed.has(a)) - Number(!managed.has(b)) || turnover(b) - turnover(a));
  }
  async _history_pass(signal) {
    const config = this.strategy_settings(), today = dateIST(this._now()), holdingTokens = this._holding_tokens();
    const wanted = this._priority_tokens(Object.keys(this.universe).map(Number).filter(t => config.swing_enabled || holdingTokens.has(t)), holdingTokens);
    const coverage = today + (config.swing_enabled ? ':all' : ':holdings:' + [...holdingTokens].sort((a, b) => a - b).join(','));
    if (!wanted.length || this._history_date === coverage || !this.connected) return;
    const broker = this.broker; this._daily_checked.clear(); let completed = 0, failed = 0;
    this._event('daily_history', 'Loading completed daily candles for NSE swing analysis. Coverage grows as the rate-limited download completes.');
    for (const token of wanted) {
      if (!this.connected || signal?.aborted || this._shutdown || broker !== this.broker || dateIST(this._now()) !== today) return;
      const cache = this.store.get(`daily:${token}`, {});
      try {
        let rows;
        if (cache.date === today) rows = cache.rows || [];
        else {
          const end = parseTime(`${today}T00:00:00+05:30`);
          rows = await broker.call('historical_data', token, new Date(end - 160 * 86400000), new Date(end - 1000), 'day');
          if (signal?.aborted || this._shutdown || broker !== this.broker || dateIST(this._now()) !== today) return;
          this.store.set(`daily:${token}`, { date: today, rows: jsonable(rows) }); await sleep(100, signal);
        }
        const bars = [];
        for (const row of rows) {
          const at = parseTime(row.date);
          if (at && dateIST(at) < today) bars.push(new Candle(at, Number(row.open), Number(row.high), Number(row.low), Number(row.close), Number(row.volume)));
        }
        if (bars.length >= (holdingTokens.has(token) ? 21 : 55) && (parseTime(today + 'T00:00:00+05:30') - parseTime(dateIST(bars.at(-1).time) + 'T00:00:00+05:30')) <= 7 * 86400000) {
          this.daily[token] = bars; this._daily_checked.delete(token);
          if (monotonic() - (this.quotes[token]?.received_at ?? -Infinity) <= 10) this._queue_current_analysis(token);
        }
        completed++;
      } catch (exc) {
        if (signal?.aborted || this._shutdown) return;
        if (!(exc instanceof BrokerError)) throw exc;
        failed++;
        if (exc.kind === 'TokenException') { this.connected = false; this._halt('Authentication expired while loading daily history. Reconnect Zerodha.', 'auth_expired'); break; }
      }
      if ((completed + failed) % 100 === 0) this._event('daily_history', 'Daily candle download progress.', { downloaded: completed, failed, ready: count(this.daily), total: count(this.universe) });
    }
    this._history_failures = failed; if (this.connected && !failed) this._history_date = coverage;
    this._event('daily_history', 'Daily history pass finished.', { downloaded: completed, failed, ready: count(this.daily), total: count(this.universe) });
  }
  async _history(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      try { await this._history_pass(signal); }
      catch (exc) { if (signal?.aborted || this._shutdown) return; this._event('daily_history_error', `Daily history unavailable (${exc.name || 'Error'}); swing entries require complete data.`, null, 'error'); }
      await sleep(30000, signal);
    }
  }
  async _intraday_history_pass(signal) {
    if (!this.connected || !marketHours(this._now()) || !this.strategy_settings().intraday_enabled || !count(this.quotes)) return;
    const managed = new Set(values(this.positions).map(p => Number(p.token))), wanted = this._priority_tokens(Object.keys(this.universe).map(Number).filter(t => !this._intraday_history_loaded.has(t)), managed);
    if (wanted.length) this._event('intraday_history', 'Loading completed five-minute candles, prioritising current turnover.', { remaining: wanted.length });
    const broker = this.broker;
    for (const token of wanted) {
      if (!this.connected || !marketHours(this._now()) || signal?.aborted || this._shutdown || broker !== this.broker) return;
      const now = this._now(), boundary = new Date(Math.floor(now.getTime() / 300000) * 300000), start = parseTime(`${dateIST(now)}T09:15:00+05:30`);
      if (boundary <= start) break;
      try {
        const rows = await broker.call('historical_data', token, start, new Date(boundary - 1000), '5minute');
        if (signal?.aborted || this._shutdown || broker !== this.broker || dateIST(this._now()) !== dateIST(now)) return;
        this._seed_intraday(token, rows, boundary); this._intraday_history_loaded.add(token);
      } catch (exc) {
        if (signal?.aborted || this._shutdown) return;
        if (!(exc instanceof BrokerError)) throw exc;
        this._intraday_history_failed++;
        if (exc.kind === 'TokenException') { this.connected = false; this._halt('Authentication expired loading intraday history. Reconnect Zerodha.', 'auth_expired'); break; }
      }
      if (this._intraday_history_loaded.size % 100 === 0) this._event('intraday_history', 'Intraday warmup progress.', { loaded: this._intraday_history_loaded.size, failed: this._intraday_history_failed, warmed: values(this.books).filter(b => b.bars.length >= 21).length, total: count(this.universe) });
      await sleep(100, signal);
    }
  }
  async _intraday_history(signal = this._controller?.signal) {
    while (!signal?.aborted && !this._shutdown) {
      try { await this._intraday_history_pass(signal); }
      catch (exc) { if (signal?.aborted || this._shutdown) return; this._event('intraday_history_error', `Intraday warmup failed (${exc.name || 'Error'}); observed candles remain available.`, null, 'error'); }
      await sleep(this.connected && !count(this.quotes) ? 1000 : 15000, signal);
    }
  }
  _seed_intraday(token, rows, boundary) {
    const book = this.books[token]; if (!book) return;
    const merged = new Map(book.bars.map(b => [b.time.getTime(), b]));
    for (const row of rows) {
      const at = parseTime(row.date);
      if (!at || dateIST(at) !== dateIST(boundary) || at.getTime() + 300000 > boundary.getTime() || timeIST(at) < '09:15' || at.getUTCMinutes() % 5 || at.getUTCSeconds()) continue;
      const fields = ['open', 'high', 'low', 'close', 'volume'].map(k => Number(row[k]));
      if (!fields.every(Number.isFinite) || Math.min(...fields.slice(0, 4)) <= 0 || fields[4] < 0 || fields[1] < Math.max(fields[0], fields[3]) || fields[2] > Math.min(fields[0], fields[3])) continue;
      if (book.current && at >= book.current.time) continue;
      merged.set(at.getTime(), new Candle(at, ...fields));
    }
    book.bars = [...merged.entries()].sort(([a], [b]) => a - b).slice(-80).map(([, b]) => b); this._queue_current_analysis(Number(token));
  }
  _analyze_holdings() {
    const config = this.strategy_settings(), selected = new Set(config.managed_symbols || []), results = [];
    for (const holding of this.account.holdings || []) {
      if (holding.exchange !== 'NSE') continue;
      const symbol = holding.tradingsymbol || '', token = Number(holding.instrument_token || 0), quantity = Math.max(0, Number(holding.quantity || 0) - Number(holding.used_quantity || 0) - Number(holding.collateral_quantity || 0)), managed = config.manage_existing_holdings === 'all' || selected.has(symbol), bars = this.daily[token] || [];
      const record = { symbol, quantity, managed, status: 'warming_up', reason: 'Waiting for completed daily candles.', action: 'analysis_only' };
      const research = this._analysis_cache.get(keyFor('swing', token))?.holding;
      if (bars.length >= 21 && research) {
        const trailing = research.trailing, trendExit = research.trend_exit, quote = this.quotes[token] || {}, fresh = monotonic() - (quote.received_at ?? -Infinity) <= 10, stopExit = fresh && Number(quote.last_price || 0) <= trailing;
        Object.assign(record, { status: trendExit || stopExit ? 'exit_candidate' : 'hold', reason: trendExit ? 'Completed daily trend weakened.' : stopExit ? 'Daily ATR stop breached.' : 'Daily trend and ATR exit conditions not triggered.', trailing_reference: round(trailing) });
        const key = `${this.day}:${symbol}`;
        if (this.mode === 'paper' && this.running && managed && quantity > 0 && (trendExit || stopExit) && fresh && !this._paper_holding_actions[key] && bidOf(quote) > 0) {
          const action = { ...record, action: 'simulated_sell', price: bidOf(quote) * .9995, time: isoIST(this._now()), note: 'Shadow holding exit; your actual holding is unchanged.' };
          this._paper_holding_actions[key] = action; this.store.set('paper_holding_actions', this._paper_holding_actions); this._event('paper_holding_exit', `Simulated exit of ${quantity} existing ${symbol} shares.`, action);
        }
        if (this._paper_holding_actions[key] && this.mode === 'paper') record.action = 'simulated_sell';
      }
      results.push(record);
    }
    this.holdings_signals = results;
  }
  snapshot() {
    const positions = values(this.positions).map(p => ({ ...p, unrealised: round(((p.last ?? p.entry) - p.entry) * p.quantity - (p.entry_fee || 0)) }));
    const pending = values(this.intents).some(i => !['closed', 'rejected'].includes(i.state)), delivery = this.delivery?.snapshot() || {}, deliveryBusy = values(delivery.positions || {}).some(p => p.status !== 'closed'), unrealised = this._unrealised();
    return jsonable({ mode: this.mode, status: this.status, connected: this.connected, user_id: this.user_id, capital: this.capital,
      equity: round(this.capital + this.realised - this._capital_accounted_pnl + unrealised), realised_pnl: round(this.realised), unrealised_pnl: round(unrealised), daily_pnl: round(this._daily_pnl()), pnl_fees_estimated: true,
      capital_source: this.mode === 'paper' ? 'persisted_paper_balance_seeded_from_broker_cash' : 'verified_broker_cash', broker_available_cash: this._broker_available_cash,
      risk_used: round(sum(values(this.positions).map(p => Math.max(0, p.entry - p.stop) * p.quantity))), universe_count: count(this.universe),
      subscribed_count: sum(entries(this.streams).filter(([, ready]) => ready).map(([i]) => Math.min(3000, count(this.universe) - Number(i) * 3000))),
      warmed_count: values(this.books).filter(b => b.bars.length >= 21).length, swing_warmed_count: count(this.daily), swing_history_failures: this._history_failures,
      heartbeat: this._heartbeat, market_open: marketHours(this._now()), feed_fresh: monotonic() - this._last_tick_received <= 10, account_fresh: monotonic() - this._account_at <= 45,
      positions, account: this.account, signals: this.signals, holdings_signals: this.holdings_signals, delivery, performance: this.analytics.snapshot(this._analysis_pending.size, this._analysis_cache.size),
      intents: values(this.intents).slice(-100), strategy_settings: this.strategy_settings(), pending_orders: [...values(this.intents).filter(i => !['closed', 'rejected', 'open'].includes(i.state)), ...values(delivery.positions || {}).filter(p => p.status !== 'closed')],
      safe_to_stop: !this._other_mode_live_risk() && (this.mode !== 'live' || (!positions.length && !pending && !deliveryBusy && !this.running)), unmanaged_live_exposure: this._other_mode_live_risk(),
      message: this.message, error: this.error, recovery: { ...this.recovery }, live_swing_supported: true,
      limitations: ['Strategies are unvalidated research rules, not proven profitable models.', 'Paper fills include a 0.05% price adjustment and estimated 0.1% fees per side.', 'New swing buys require DDPI/POA; existing holding sales can request current-day CDSL authorization. GTT limits do not guarantee fills through gaps or circuits.', 'Exchange holidays are inferred from fresh market data; no holiday calendar is assumed.'] });
  }
}
