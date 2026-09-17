/** Bounded, in-memory work telemetry. Older asynchronous passes cannot overwrite
 * a replacement pass after reconnect, refresh or shutdown. No broker payloads. */
export class BackgroundActivity {
  constructor(now = () => new Date()) {
    this.now = now;
    this.sequence = 0;
    this.tasks = new Map(Object.entries({account:'Account reconciliation',universe:'NSE security universe',daily_history:'Daily candle history',intraday_history:'Five-minute candle history',market_context:'Market and sector context',analytics:'Strategy analytics',execution:'Trading decisions and position management'}).map(([id,label])=>[id,{id,label,status:'idle',message:'Waiting for Zerodha connection.',current_item:null,completed:0,total:0,failed:0,updated_at:null,next_retry_at:null}]));
  }
  begin(id, patch = {}) {
    const revision = ++this.sequence;
    const update = value => {
      const task = this.tasks.get(id);
      if (!task || task.revision !== revision) return;
      Object.assign(task, value, {updated_at:this.now().toISOString()});
      if (task.status !== 'running') task.current_item = null;
    };
    Object.assign(this.tasks.get(id), {revision,status:'running',current_item:null,completed:0,total:0,failed:0,next_retry_at:null},patch);
    update({});
    return update;
  }
  stop() {
    for (const task of this.tasks.values()) Object.assign(task,{revision:++this.sequence,status:'stopped',message:'Background monitoring stopped.',current_item:null,next_retry_at:null,updated_at:this.now().toISOString()});
  }
  snapshot() { return [...this.tasks.values()].map(({revision,...task})=>({...task})); }
}
