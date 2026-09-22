import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { hashPassword, randomSecret, Fernet } from './security.js';
import { DEFAULT_MIN_ENTRY_REWARD_RISK } from './entry-risk.js';

export const DEFAULTS = Object.freeze({
  port:3000, admin_username:'admin',
  trading_mode:'paper', live_trading_enabled:false,
  max_position_pct:0.10, risk_per_trade_pct:0.0025, daily_loss_pct:0.01, max_positions:5,
  min_entry_reward_risk:DEFAULT_MIN_ENTRY_REWARD_RISK,
  entry_cutoff:'14:45', exit_time:'15:10', data_dir:'data', max_spread_pct:0.003,
  min_daily_turnover:10000000, analytics_workers:0, analytics_reserve_cpus:4, analytics_batch_size:32,
  min_free_disk_mib:512,min_free_memory_mib:256,max_event_loop_delay_ms:2000,
  enhanced_signals:true, enable_breakout:true, enable_pullback:true, enable_reversion:true, candlestick_patterns_enabled:true,
  enable_opening_range:true,enable_opening_drive:true,enable_gap_continuation:true,enable_gap_reversal:true,enable_vwap_reclaim:true,enable_vwap_rejection:true,enable_volatility_squeeze:true,enable_relative_strength:true,
  intraday_short_enabled:true,higher_timeframe_filter:true,opening_range_minutes:15,min_setup_volume:1.2,min_gap_pct:0.005,max_gap_pct:0.05,relative_strength_min:0.002,squeeze_width_max:0.02,squeeze_lookback:20,
  event_risk_enabled:true,event_blackout_before_days:1,event_blackout_after_days:1,market_context_max_age_minutes:60,classification_max_age_days:7,benchmark_max_age_seconds:120,
  min_signal_score:60, min_adx:18, min_rsi:45, max_rsi:78, max_atr_extension:2.5, technical_exit_enabled:true,
  candidate_wait_ms:1500, market_regime_filter:false, min_market_breadth:0.45, min_market_samples:30, min_market_coverage:0.20,
  portfolio_risk_enabled:true, max_account_stock_pct:0.25, max_account_gross_pct:0.90, max_account_risk_pct:0.03, unprotected_stress_pct:0.05,
  correlation_filter:true, max_correlation:0.85, max_correlated_exposure_pct:0.35,
  max_trades_per_day:10, loss_streak_limit:3, loss_cooldown_minutes:30,
  auto_research:true, research_symbols:20, research_days:45, research_fee_rate:0.001, research_slippage_rate:0.0005,
  research_workers:0, research_cpu_affinity:'pinned',
});
export const FIELDS = [
  ['port','Local server port','number'],
  ['admin_username','Administrator username','text'],['data_dir','Data directory','text'],
  ['trading_mode','Trading mode','select',['paper','live']],['live_trading_enabled','Enable real order execution','checkbox'],
  ['max_position_pct','Maximum allocation per stock (fraction)','number'],['risk_per_trade_pct','Risk per trade (fraction)','number'],
  ['daily_loss_pct','Daily loss limit (fraction)','number'],['max_positions','Maximum positions','number'],
  ['min_entry_reward_risk','Minimum entry reward/risk after estimated costs','number'],
  ['entry_cutoff','Intraday entry cutoff (IST)','time'],['exit_time','Intraday close target (IST)','time'],
  ['max_spread_pct','Maximum spread (fraction)','number'],['min_daily_turnover','Minimum daily turnover (₹)','number'],
  ['analytics_workers','Analytics workers (0 = automatic)','number'],['analytics_reserve_cpus','CPU reserve','number'],
  ['analytics_batch_size','Analysis batch size','number'],
  ['min_free_disk_mib','Minimum free journal disk space (MiB)','number'],['min_free_memory_mib','Minimum free system memory (MiB)','number'],['max_event_loop_delay_ms','Maximum event loop delay before entries wait (ms)','number'],
  ['enhanced_signals','Use enhanced strategy selection','checkbox'],
  ['enable_breakout','Enable breakout setups','checkbox'],['enable_pullback','Enable trend pullbacks','checkbox'],['enable_reversion','Enable range reversion setups','checkbox'],
  ['enable_opening_range','Enable opening range breaks','checkbox'],['enable_opening_drive','Enable opening drive','checkbox'],['enable_gap_continuation','Enable gap continuation','checkbox'],['enable_gap_reversal','Enable gap reversal','checkbox'],
  ['enable_vwap_reclaim','Enable VWAP reclaim','checkbox'],['enable_vwap_rejection','Enable VWAP rejection','checkbox'],['enable_volatility_squeeze','Enable volatility squeeze breaks','checkbox'],['enable_relative_strength','Enable benchmark relative strength','checkbox'],
  ['intraday_short_enabled','Allow protected intraday short entries','checkbox'],['higher_timeframe_filter','Require completed higher timeframe trend alignment','checkbox'],['opening_range_minutes','Opening range length (minutes)','number'],
  ['min_setup_volume','Minimum setup relative volume','number'],['min_gap_pct','Minimum opening gap (fraction)','number'],['max_gap_pct','Maximum opening gap (fraction)','number'],['relative_strength_min','Minimum excess return over benchmark (fraction)','number'],['squeeze_width_max','Maximum compression bandwidth (fraction)','number'],['squeeze_lookback','Compression lookback candles','number'],
  ['event_risk_enabled','Block new entries around scheduled earnings events or stale calendar','checkbox'],['event_blackout_before_days','Calendar days blocked before earnings event','number'],['event_blackout_after_days','Calendar days blocked after earnings event','number'],
  ['market_context_max_age_minutes','Maximum earnings calendar age (minutes)','number'],['classification_max_age_days','Maximum sector classification age (days)','number'],['benchmark_max_age_seconds','Maximum benchmark quote age (seconds)','number'],
  ['candlestick_patterns_enabled','Use contextual candlestick confirmations','checkbox'],['technical_exit_enabled','Exit owned trades on confirmed technical deterioration','checkbox'],
  ['min_signal_score','Minimum evidence score (0–100; not probability)','number'],['min_adx','Minimum trend ADX','number'],
  ['min_rsi','Minimum trend RSI','number'],['max_rsi','Maximum trend RSI','number'],['max_atr_extension','Maximum distance from EMA21 in ATR units','number'],
  ['candidate_wait_ms','Opportunity collection window (milliseconds)','number'],
  ['market_regime_filter','Gate new entries on directional market breadth','checkbox'],['min_market_breadth','Minimum advancing (long) or declining (short) fraction','number'],
  ['min_market_samples','Minimum liquid stocks for breadth','number'],['min_market_coverage','Minimum fresh quote coverage of Nifty Total Market universe','number'],
  ['portfolio_risk_enabled','Include existing account exposure in entry risk checks','checkbox'],['max_account_stock_pct','Maximum stock fraction of reference assets','number'],
  ['max_account_gross_pct','Maximum gross exposure fraction of reference assets','number'],['max_account_risk_pct','Maximum estimated account stress loss fraction','number'],['unprotected_stress_pct','Stress move for exposure without a verified stop','number'],
  ['correlation_filter','Limit historically correlated exposure','checkbox'],['max_correlation','Daily return correlation threshold','number'],['max_correlated_exposure_pct','Maximum correlated group fraction of reference assets','number'],
  ['max_trades_per_day','Maximum new symbols attempted per day','number'],['loss_streak_limit','Consecutive realized loss events before cooldown','number'],['loss_cooldown_minutes','Loss cooldown (minutes)','number'],
  ['auto_research','Automatically refresh daily research when account data is ready','checkbox'],['research_symbols','Nifty Total Market research stocks (0 = all constituents)','number'],['research_days','Historical research lookback (calendar days)','number'],
  ['research_fee_rate','Research estimated costs per side (fraction)','number'],['research_slippage_rate','Research adverse slippage per side (fraction)','number'],
  ['research_workers','Parallel comparison workers (0 = automatic)','number'],
  ['research_cpu_affinity','Research CPU scheduling','select',['pinned','automatic']],
].map(([key,label,type,choices])=>({key,label,type,choices}));
/** Resolve existing parents as well as the final path, including directory links. */
export function canonicalPath(filename) {
  let current=path.resolve(filename);const missing=[];
  for(;;){
    try{fs.lstatSync(current);return path.join(fs.realpathSync(current),...missing.reverse());}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      // A dangling link must not become an unchecked path alias later.
      try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('Cannot resolve a dangling directory link');}catch(linkError){if(linkError.code!=='ENOENT')throw linkError;}
      const parent=path.dirname(current);if(parent===current)throw new Error('Cannot resolve the configured path');
      missing.push(path.basename(current));current=parent;
    }
  }
}
export function pathWithin(filename,directory) {
  const relative=path.relative(canonicalPath(directory),canonicalPath(filename));
  return relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
}
export class Settings {
  constructor(values = {}, root = process.cwd()) {
    Object.assign(this, DEFAULTS, {admin_password_hash:'',session_secret:'',token_encryption_key:'',kite_api_key:'',kite_api_secret:'',kite_user_id:''}, values);
    if(!Object.hasOwn(values,'research_workers')&&Object.hasOwn(values,'research_tuning_workers'))this.research_workers=values.research_tuning_workers;
    for(const key of ['research_tuning','research_tuning_apply','research_tuning_trials','research_tuning_seconds','research_tuning_workers'])delete this[key];
    this.root = root; if(typeof this.data_dir!=='string'||!this.data_dir.trim())throw new Error('Choose a data directory'); this.data_dir = path.resolve(root, this.data_dir);
  }
  get configured() { return Boolean(this.kite_api_key && this.kite_api_secret && this.kite_user_id && !this.kite_api_key.startsWith('your-') && !this.kite_api_secret.startsWith('your-')); }
  validate() {
    if(pathWithin(this.data_dir,path.join(this.root,'public')))throw new Error('Data directory must be outside publicly served files');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(this.admin_username) || !this.admin_password_hash.startsWith('$argon2') || this.session_secret.length < 32) throw new Error('Invalid administrator configuration');
    new Fernet(this.token_encryption_key);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('Port must be between 1 and 65535');
    if (!['paper','live'].includes(this.trading_mode) || typeof this.live_trading_enabled !== 'boolean') throw new Error('Invalid trading mode');
    if (!Number.isFinite(this.min_entry_reward_risk) || this.min_entry_reward_risk < 1 || this.min_entry_reward_risk > 10) throw new Error('min_entry_reward_risk must be between 1 and 10');
    for (const key of ['max_position_pct','risk_per_trade_pct','daily_loss_pct','max_spread_pct','min_daily_turnover']) if (!Number.isFinite(this[key])) throw new Error(`${key} must be finite`);
    if (!(0 < this.risk_per_trade_pct && this.risk_per_trade_pct <= this.max_position_pct && this.max_position_pct <= 1 && this.daily_loss_pct > 0 && this.daily_loss_pct <= 1)) throw new Error('Invalid risk fractions');
    if (!Number.isInteger(this.max_positions) || this.max_positions < 1 || this.max_positions > 50 || this.max_spread_pct <= 0 || this.max_spread_pct >= 1 || this.min_daily_turnover < 0) throw new Error('Invalid position or liquidity limits');
    for (const key of ['analytics_workers','analytics_reserve_cpus']) if (!Number.isInteger(this[key]) || this[key] < 0 || this[key] > 1024) throw new Error(`${key} must be between 0 and 1024`);
    if (!Number.isInteger(this.analytics_batch_size) || this.analytics_batch_size < 1 || this.analytics_batch_size > 256) throw new Error('Analysis batch size must be between 1 and 256');
    for(const [key,min,max] of [['min_free_disk_mib',64,1048576],['min_free_memory_mib',64,1048576],['max_event_loop_delay_ms',100,10000]])if(!Number.isInteger(this[key])||this[key]<min||this[key]>max)throw new Error(`${key} must be an integer between ${min} and ${max}`);
    for(const {key,type} of FIELDS)if(type==='checkbox'&&typeof this[key]!=='boolean')throw new Error(`${key} must be true or false`);
    if(this.enhanced_signals&&!Object.keys(DEFAULTS).some(k=>k.startsWith('enable_')&&this[k]))throw new Error('Enable at least one enhanced strategy family');
    for(const [key,min,max] of [['min_setup_volume',0.1,10],['min_gap_pct',0.001,0.2],['max_gap_pct',0.001,0.2],['relative_strength_min',0.0001,0.1],['squeeze_width_max',0.001,0.5]])if(!Number.isFinite(this[key])||this[key]<min||this[key]>max)throw new Error(`${key} must be between ${min} and ${max}`);
    if(this.min_gap_pct>=this.max_gap_pct)throw new Error('Minimum gap must be below maximum gap');
    for(const [key,min,max] of [['opening_range_minutes',5,60],['squeeze_lookback',5,60],['event_blackout_before_days',0,7],['event_blackout_after_days',0,7],['market_context_max_age_minutes',5,1440],['classification_max_age_days',1,30],['benchmark_max_age_seconds',10,300]])if(!Number.isInteger(this[key])||this[key]<min||this[key]>max)throw new Error(`${key} must be an integer between ${min} and ${max}`);
    if(this.opening_range_minutes%5!==0)throw new Error('Opening range must be a multiple of five minutes');
    for(const [key,min,max] of [['min_signal_score',0,100],['min_adx',0.1,60],['min_rsi',0,99],['max_rsi',1,100],['max_atr_extension',0.1,10],['min_market_breadth',0,1],['min_market_coverage',0,1],['max_account_stock_pct',0.01,1],['max_account_gross_pct',0.01,1],['max_account_risk_pct',0.001,1],['unprotected_stress_pct',0.001,1],['max_correlation',0.01,1],['max_correlated_exposure_pct',0.01,1],['research_fee_rate',0,0.02],['research_slippage_rate',0,0.02]])if(!Number.isFinite(this[key])||this[key]<min||this[key]>max)throw new Error(`${key} must be between ${min} and ${max}`);
    if(this.min_rsi>=this.max_rsi)throw new Error('Minimum RSI must be below maximum RSI');
    for(const [key,min,max] of [['research_workers',0,100]])if(!Number.isInteger(this[key])||this[key]<min||this[key]>max)throw new Error(`${key} must be an integer between ${min} and ${max}`);
    if(!['pinned','automatic'].includes(this.research_cpu_affinity))throw new Error('Research CPU scheduling must be pinned or automatic');
    for(const [key,min,max] of [['candidate_wait_ms',0,10000],['min_market_samples',1,9000],['max_trades_per_day',1,100],['loss_streak_limit',1,20],['loss_cooldown_minutes',1,240],['research_symbols',0,1000],['research_days',10,60]])if(!Number.isInteger(this[key])||this[key]<min||this[key]>max)throw new Error(`${key} must be an integer between ${min} and ${max}`);
    if (![this.entry_cutoff,this.exit_time].every(v=>/^\d\d:\d\d$/.test(v)&&Number(v.slice(3))<60) || !('09:15'<this.entry_cutoff&&this.entry_cutoff<this.exit_time&&this.exit_time<'15:30')) throw new Error('Require 09:15 < entry cutoff < close target < 15:30 IST');
    return this;
  }
  publicValues() {
    const values=Object.fromEntries(Object.keys(DEFAULTS).map(key=>[key,this[key]]));
    const relative=path.relative(this.root,this.data_dir);
    // Keep ordinary project-local paths portable when a Settings form is saved.
    if(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep))values.data_dir=relative||'.';
    return values;
  }
}
export function atomicJSON(filename, data) {
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(data,null,2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary,filename); } finally { if(fs.existsSync(temporary))fs.unlinkSync(temporary); }
}
export class ConfigManager {
  constructor(root = process.cwd(), environment = process.env) { this.root = path.resolve(root); this.filename = path.join(this.root,'config','settings.json'); this.environment = environment; }
  async load({onInitialPassword=()=>{},password=null}={}) {
    const envFile = path.join(this.root,'.env');
    const env = {...(fs.existsSync(envFile)?dotenv.parse(fs.readFileSync(envFile)):{}),...this.environment};
    let saved;
    if (fs.existsSync(this.filename)) saved = JSON.parse(fs.readFileSync(this.filename,'utf8'));
    else {
      saved = {...DEFAULTS};
      // Adopt legacy configuration once, preserving encryption keys and journal path.
      for (const [key,base] of Object.entries(DEFAULTS)) if(env[key.toUpperCase()]!==undefined){const v=env[key.toUpperCase()];saved[key]=typeof base==='number'?Number(v):typeof base==='boolean'?v==='true':v;}
      saved.session_secret = env.SESSION_SECRET || randomSecret();
      saved.token_encryption_key = env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64').replaceAll('+','-').replaceAll('/','_');
      if(env.ADMIN_PASSWORD_HASH) saved.admin_password_hash=env.ADMIN_PASSWORD_HASH;
      else { const initial=password||randomSecret(18); saved.admin_password_hash=await hashPassword(initial); this.initialPassword=initial; }
      new Settings(saved,this.root).validate(); atomicJSON(this.filename,saved);
      if(this.initialPassword)onInitialPassword(this.initialPassword);
    }
    this.saved = saved;
    this.credentials = Object.fromEntries(['kite_api_key','kite_api_secret','kite_user_id'].map(key=>[key,String(env[key.toUpperCase()]||'').trim()]));
    this.credentials.kite_user_id=this.credentials.kite_user_id.toUpperCase();
    return this.settings = new Settings({...saved,...this.credentials},this.root).validate();
  }
  candidate(changes) { return new Settings({...this.saved,...changes,...this.credentials},this.root).validate(); }
  save(changes) { const next=this.candidate(changes), saved={...this.saved,...changes}; atomicJSON(this.filename,saved); this.saved=saved; return next; }
}
