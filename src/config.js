import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { hashPassword, randomSecret, Fernet } from './security.js';

export const DEFAULTS = Object.freeze({
  port:3000, admin_username:'admin',
  trading_mode:'paper', live_trading_enabled:false,
  max_position_pct:0.10, risk_per_trade_pct:0.0025, daily_loss_pct:0.01, max_positions:5,
  entry_cutoff:'14:45', exit_time:'15:10', data_dir:'data', max_spread_pct:0.003,
  min_daily_turnover:10000000, analytics_workers:0, analytics_reserve_cpus:4, analytics_batch_size:32,
});
export const FIELDS = [
  ['port','Local server port','number'],
  ['admin_username','Administrator username','text'],['data_dir','Data directory','text'],
  ['trading_mode','Trading mode','select',['paper','live']],['live_trading_enabled','Enable real order execution','checkbox'],
  ['max_position_pct','Maximum allocation per stock (fraction)','number'],['risk_per_trade_pct','Risk per trade (fraction)','number'],
  ['daily_loss_pct','Daily loss limit (fraction)','number'],['max_positions','Maximum positions','number'],
  ['entry_cutoff','Intraday entry cutoff (IST)','time'],['exit_time','Intraday close target (IST)','time'],
  ['max_spread_pct','Maximum spread (fraction)','number'],['min_daily_turnover','Minimum daily turnover (₹)','number'],
  ['analytics_workers','Analytics workers (0 = automatic)','number'],['analytics_reserve_cpus','CPU reserve','number'],
  ['analytics_batch_size','Analysis batch size','number'],
].map(([key,label,type,choices])=>({key,label,type,choices}));
export class Settings {
  constructor(values = {}, root = process.cwd()) { Object.assign(this, DEFAULTS, {admin_password_hash:'',session_secret:'',token_encryption_key:'',kite_api_key:'',kite_api_secret:'',kite_user_id:''}, values); this.root = root; if(typeof this.data_dir!=='string'||!this.data_dir.trim())throw new Error('Choose a data directory'); this.data_dir = path.resolve(root, this.data_dir); }
  get configured() { return Boolean(this.kite_api_key && this.kite_api_secret && this.kite_user_id && !this.kite_api_key.startsWith('your-') && !this.kite_api_secret.startsWith('your-')); }
  validate() {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(this.admin_username) || !this.admin_password_hash.startsWith('$argon2') || this.session_secret.length < 32) throw new Error('Invalid administrator configuration');
    new Fernet(this.token_encryption_key);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('Port must be between 1 and 65535');
    if (!['paper','live'].includes(this.trading_mode) || typeof this.live_trading_enabled !== 'boolean') throw new Error('Invalid trading mode');
    for (const key of ['max_position_pct','risk_per_trade_pct','daily_loss_pct','max_spread_pct','min_daily_turnover']) if (!Number.isFinite(this[key])) throw new Error(`${key} must be finite`);
    if (!(0 < this.risk_per_trade_pct && this.risk_per_trade_pct <= this.max_position_pct && this.max_position_pct <= 1 && this.daily_loss_pct > 0 && this.daily_loss_pct <= 1)) throw new Error('Invalid risk fractions');
    if (!Number.isInteger(this.max_positions) || this.max_positions < 1 || this.max_positions > 50 || this.max_spread_pct <= 0 || this.max_spread_pct >= 1 || this.min_daily_turnover < 0) throw new Error('Invalid position or liquidity limits');
    for (const key of ['analytics_workers','analytics_reserve_cpus']) if (!Number.isInteger(this[key]) || this[key] < 0 || this[key] > 1024) throw new Error(`${key} must be between 0 and 1024`);
    if (!Number.isInteger(this.analytics_batch_size) || this.analytics_batch_size < 1 || this.analytics_batch_size > 256) throw new Error('Analysis batch size must be between 1 and 256');
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
