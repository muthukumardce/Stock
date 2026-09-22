import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {ResearchService,COMPARISON_RUNTIME_POLICY} from './research.js';
import {selectIndexResearchSymbols} from './research-selection.js';
import {BROAD_INDEX_NAMES} from './market-context.js';
import {MAX_RESEARCH_BARS} from './backtest.js';
import {STRATEGY_VERSION} from './strategy.js';
import {DEFAULT_MIN_ENTRY_REWARD_RISK} from './entry-risk.js';
import {validate_bars} from './indicators.js';
import {dateIST,timeIST,isoIST,parseTime,sleep} from './util.js';

const busy=new Set(['collecting','running']);
const RESEARCH_WORKFLOW_VERSION='nifty-comparison-only-v4';
function comparisonReport(saved){
  if(!saved)return null;
  const {optimization,...report}=saved;
  if(report.alternate_reports)report.alternate_reports=Object.fromEntries(Object.entries(report.alternate_reports).map(([key,value])=>[key,comparisonReport(value)]));
  return report;
}
const compactRun=run=>run?{...run,trades:(run.trades||[]).slice(-100),equity:(run.equity||[]).filter((_,i,a)=>i%Math.max(1,Math.ceil(a.length/1000))===0||i===a.length-1)}:null;
const compactReport=report=>report?{...report,baseline:compactRun(report.baseline),enhanced:compactRun(report.enhanced)}:null;
const issueLimit=50;
const messages={rate_limit:'Zerodha rate limited research requests. Collection is paused until the retry time; valid downloaded candles are retained.',authentication:'The Zerodha session is no longer valid. Reconnect Zerodha, then retry research.',permission:'Zerodha denied research data access. Check the Kite app historical-data permission or subscription, then retry research.',network:'Research data could not be retrieved because of a network or broker service interruption. Available data is retained for retry.',data_coverage:'The requested history has no usable completed candles. Check symbol coverage and the requested date range; incomplete data will be retried.',worker_timeout:'The local research calculation exceeded its time limit. Reduce Research symbols or Research days in Settings before retrying; this is separate from broker API rate limiting.',worker:'The research worker did not produce a report. Review local resources and research dataset size before retrying.',error:'Research could not complete at the reported stage. Review Activity and retry after checking data access and local resources.'};
messages.cpu_affinity='A research worker could not verify its assigned CPU. Select Automatic scheduling in Research settings to run without CPU pinning, or review the machine CPU restrictions before retrying.';
class ResearchFailure extends Error {
  constructor(diagnostic,retryAfter=0){super(diagnostic.message);this.diagnostic=diagnostic;this.retryAfter=retryAfter;}
}
function researchFailure(error,phase='collection',symbol=null,code=null){
  if(error instanceof ResearchFailure)return error;
  const status=Number(error?.http_status??error?.status),http_status=Number.isInteger(status)&&status>=400&&status<=599?status:null;
  code=code||(http_status===429||error?.rate_limited?'rate_limit':http_status===401||error?.kind==='TokenException'?'authentication':http_status===403||error?.kind==='PermissionException'?'permission':http_status>=500||['NetworkException','GeneralException'].includes(error?.kind)||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN'].includes(error?.code)||['AbortError','TimeoutError'].includes(error?.name)?'network':'error');
  const retry=Number(error?.retry_after_seconds);
  return new ResearchFailure({code,message:messages[code],http_status,phase,symbol:typeof symbol==='string'&&/^[A-Z0-9&. -]{1,60}$/.test(symbol)?symbol:null,retryable:!['authentication','permission','worker_timeout','cpu_affinity'].includes(code),next_retry_at:null},Number.isFinite(retry)?Math.max(1,Math.min(86400,retry))*1000:0);
}
function workerFailure(job,phase){
  if(job.error_code==='cpu_affinity')return researchFailure(null,phase,null,'cpu_affinity');
  const timeout=job.error?.code==='worker_timeout'||job.error_code==='worker_timeout'||['Research exceeded its time limit; reduce dataset size','Backtest runtime limit exceeded; use a smaller dataset'].includes(job.error);
  const failure=researchFailure(null,phase,null,timeout?'worker_timeout':'worker');
  if(!timeout)return failure;
  const detail=job.error_details||{},diagnostic=failure.diagnostic;
  const budget=detail.budget_ms??job.runtime_budget_ms;
  if(Number.isSafeInteger(budget)&&budget>0&&budget<=7200000)diagnostic.runtime_budget_ms=budget;
  if(Number.isSafeInteger(detail.processed_bars)&&Number.isSafeInteger(detail.total_bars)&&detail.processed_bars>=0&&detail.total_bars>0&&detail.processed_bars<=detail.total_bars&&detail.total_bars<=MAX_RESEARCH_BARS*2){diagnostic.processed_bars=detail.processed_bars;diagnostic.total_bars=detail.total_bars;}
  if(['variant','watchdog'].includes(detail.kind))diagnostic.timeout_kind=detail.kind;
  if(diagnostic.runtime_budget_ms){
    const minutes=budget/60000,duration=Number.isInteger(minutes)?`${minutes} minute${minutes===1?'':'s'}`:`${budget/1000} seconds`;
    const label=detail.kind==='watchdog'?'research worker':({worker_baseline:'baseline simulation',worker_enhanced:'enhanced simulation'})[phase]||'historical simulation';
    const counts=diagnostic.total_bars?` The last reported phase processed ${diagnostic.processed_bars.toLocaleString('en-IN')} of ${diagnostic.total_bars.toLocaleString('en-IN')} candles.`:'';
    diagnostic.message=`The local ${label} reached its ${duration} time limit.${counts} Retry with fewer research stocks or fewer Research days. Valid downloaded candles remain cached. This is separate from broker API rate limiting.`;
  }
  return failure;
}

// Research intentionally retains missing sessions/candles for causal gap
// reporting. Only malformed or empty series are unusable; they must not become
// a same-day negative cache that prevents a recovered provider being retried.
function historyRows(rows,start,end,interval){
  if(!Array.isArray(rows)||!rows.length||rows.length>5000||!validate_bars(rows).valid)return null;
  const completed=rows.filter(row=>{const at=parseTime(row.time??row.date);return at>=start&&at<end;});
  if(!completed.length)return null;
  let previousDay=null;
  for(const row of completed){
    const at=parseTime(row.time??row.date),day=dateIST(at),clock=timeIST(at);
    if(interval==='5minute'&&(+at%300000!==0||clock<'09:15'||clock>'15:25'))return null;
    if(interval==='day'&&day===previousDay)return null;
    previousDay=day;
  }
  return completed.map(row=>({time:isoIST(parseTime(row.time??row.date)),open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume}));
}

/** Account-bound read-only data collection. The worker never receives a broker,
 * credentials, database handle or ability to submit orders. */
export class HistoricalResearch {
  constructor(engine,store,settings,{worker,now=()=>new Date(),monotonicNow=()=>performance.now(),delay=500,pollInterval=30000,retryBase=60000,retryMax=1800000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    this.engine=engine;this.store=store;this.settings=settings;this.worker=worker||new ResearchService();this.now=now;this.delay=delay;
    const previous=comparisonReport(store.get('research_report',null));
    // Retired refinement must never apply a queued change after an upgrade.
    store.delete('research_pending_tuning');
    const savedFailure=store.get('research_failure',null),failed=savedFailure?.error?.phase?.startsWith('tuning')?null:savedFailure;
    this.state={status:failed?'failed':previous?'complete':'idle',progress:previous&&!failed?100:0,progress_detail:null,message:failed?.error?.message||(previous?'Previous research report restored.':'Research starts after account connection.'),report:previous,started_at:null,completed_at:failed?.completed_at||previous?.completed_at||null,error:failed?.error||null,issues:failed?.issues||[]};
    this.controller=null;this.task=null;this.closed=false;this.generation=0;this.tasks=new Set();
    this.pollInterval=pollInterval;this.retryBase=retryBase;this.retryMax=retryMax;this.setTimer=setTimer;this.clearTimer=clearTimer;this.timer=null;this.automatic=false;this.canRun=()=>true;
    this.blockedBroker=this.store.get('research_access_block')?this.engine.broker:null;
    this.monotonicNow=monotonicNow;this.cooldownMemo=null;
  }
  _selectionPlan(){
    const universe=this.engine.universe||{},context=this.engine.market_context;
    // Quotes do not affect selection. Reuse classification work across dashboard
    // polling; invalidate on membership, freshness, scope or instrument changes.
    const index=context?.researchConstituents?.();
    const key=JSON.stringify([Object.entries(universe).map(([token,i])=>[token,i.tradingsymbol,i.entry_eligible]),this.settings.research_symbols,index]);
    if(this.selectionCache?.key!==key){
      this.selectionCache={key,plan:selectIndexResearchSymbols(universe,this.settings.research_symbols,index)};
    }
    return this.selectionCache.plan;
  }
  _selection(){return this._selectionPlan().selected;}
  signature(){
    // The engine derives these rupee amounts from current funds. A balance
    // refresh must unblock a waiting job without repeatedly redoing its report.
    const {intraday_capital,swing_capital,...strategies}=this.engine.strategy_settings?.()||{};
    return createHash('sha256').update(JSON.stringify([STRATEGY_VERSION,RESEARCH_WORKFLOW_VERSION,this.settings.kite_user_id||this.engine.user_id||null,this.settings.publicValues?.(),dateIST(this.now()),this.settings.research_symbols,this.settings.research_days,this.engine._strategy_options?.(),strategies,this._backtestOptions(0),this._selectionPlan()])).digest('hex');
  }
  _backtestOptions(capital){return {initial_capital:capital,risk_per_trade_pct:this.settings.risk_per_trade_pct,max_position_pct:this.settings.max_position_pct,max_positions:this.settings.max_positions,min_entry_reward_risk:this.settings.min_entry_reward_risk===undefined?DEFAULT_MIN_ENTRY_REWARD_RISK:this.settings.min_entry_reward_risk,fee_rate:this.settings.research_fee_rate,slippage_rate:this.settings.research_slippage_rate,entry_cutoff:this.settings.entry_cutoff,exit_time:this.settings.exit_time,max_bars:MAX_RESEARCH_BARS};}
  _retry(signature){const saved=this.store.get('research_auto_retry');return saved?.signature===signature?saved:{signature,failures:0,next_retry_at:null,cancelled:false};}
  _retryDelay(failures){return Math.min(this.retryMax,this.retryBase*2**Math.min(20,Math.max(0,failures)));}
  _accessSignature(){
    const {intraday_capital,swing_capital,...strategies}=this.engine.strategy_settings?.()||{};
    return createHash('sha256').update(JSON.stringify([this.settings.kite_api_key,this.settings.kite_user_id,this.store.get('kite_session'),this.settings.research_symbols,this.settings.research_days,this.engine._strategy_options?.(),strategies])).digest('hex');
  }
  _accessBlock(){
    const block=this.store.get('research_access_block');
    if(block?.error?.phase?.startsWith('tuning'))return null;
    if(block?.error?.code==='cpu_affinity'&&this.settings.research_cpu_affinity==='automatic')return null;
    // A previous comparison deadline must not prevent a retry under a revised
    // workload budget. Authentication and permission blocks are retained.
    if(block?.error?.code==='worker_timeout'&&block.runtime_policy!==COMPARISON_RUNTIME_POLICY)return null;
    return block&&block.signature===this._accessSignature()&&(!this.blockedBroker||this.blockedBroker===this.engine.broker)?block:null;
  }
  _cooldown(){
    const cooldown=this.store.get('research_rate_limit'),at=+new Date(cooldown?.next_retry_at);
    if(!Number.isFinite(at))return null;
    if(this.cooldownMemo?.key!==cooldown.next_retry_at)this.cooldownMemo={key:cooldown.next_retry_at,expires:this.monotonicNow()+Math.max(0,Math.min(86400000,at-this.now()))};
    const remaining=this.cooldownMemo.expires-this.monotonicNow();
    return remaining>0?{next_retry_at:isoIST(new Date(+this.now()+remaining))}:null;
  }
  _issue(failure){if(this.state.issues.length<issueLimit)this.state.issues.push({...failure.diagnostic});return failure;}
  _progress(percent){
    // Only a persisted, completed report earns 100%. Stage weights describe
    // completed work, not elapsed time, and never reset between enabled scopes.
    if(Number.isFinite(percent))this.state.progress=Math.max(this.state.progress,Math.min(99,Math.max(0,Math.round(percent*10)/10)));
  }
  _currentTask(title,detail=title){this.state.current_task={title,detail};this.state.message=detail;}
  _stageProgress(stage,completed=null,total=null,unit=null,percent=null){
    const counts=Number.isSafeInteger(completed)&&Number.isSafeInteger(total)&&completed>=0&&total>0&&completed<=total;
    this.state.progress_detail={scope:'overall',stage,stage_progress:Number.isFinite(percent)?Math.max(0,Math.min(100,percent)):counts?completed/total*100:null,
      completed:counts?completed:null,total:counts?total:null,unit};
  }
  _automaticStatus(){
    const base={enabled:Boolean(this.settings.auto_research),status:'ready',reason:'Research will start automatically when the account is ready.',next_retry_at:null,failures:0};
    if(this.closed)return {...base,status:'stopped',reason:'Research service is stopped.'};
    if(!base.enabled)return {...base,status:'disabled',reason:'Automatic research is disabled in Settings.'};
    const signature=this.signature(),retry=this._retry(signature);base.failures=retry.failures;
    if(!this.canRun())return {...base,status:'waiting',reason:'Research is waiting for the server restart or maintenance to finish.'};
    if(busy.has(this.state.status))return {...base,status:'running',reason:this.state.current_task?.title||this.state.message||'Preparing historical research.'};
    if(this.store.get('research_auto_signature')===signature)return {...base,status:'complete',reason:'The current daily strategy comparison is already complete.'};
    if(retry.cancelled)return {...base,status:'cancelled',reason:'Automatic research was cancelled for this comparison. Run research to resume it.'};
    if(this.tasks.size)return {...base,status:'waiting',reason:'Waiting for the previous historical request to finish.'};
    const access=this._accessBlock();if(access)return {...base,status:'action_required',reason:access.error.message};
    const cooldown=this._cooldown();if(cooldown)return {...base,status:'retry_wait',reason:messages.rate_limit,next_retry_at:cooldown.next_retry_at};
    if(!this.engine.connected||!this.engine.broker)return {...base,status:'waiting',reason:'Connect Zerodha before collecting historical data.'};
    const capital=this.engine.capital||this.engine._portfolio?.().reference_assets||0;
    if(!Number.isFinite(capital)||capital<=0)return {...base,status:'waiting',reason:'Waiting for a verified positive account balance or holding value.'};
    const config=this.engine.strategy_settings?.()||{};
    if(!config.intraday_enabled&&!config.swing_enabled)return {...base,status:'waiting',reason:'Enable intraday or swing before starting research.'};
    if(!this._selection().length)return {...base,status:'waiting',reason:this._selectionPlan().blocked_reason};
    if(retry.code!=='rate_limit'&&retry.next_retry_at&&+new Date(retry.next_retry_at)>+this.now())return {...base,status:'retry_wait',reason:'Historical data collection will retry automatically after a temporary interruption.',next_retry_at:retry.next_retry_at};
    return base;
  }
  _statusFields(){const cooldown=this._cooldown(),selection=this._selectionPlan();return {universe:{...selection.scope,message:selection.blocked_reason},cooldown,error:this.state.error?.code==='rate_limit'?{...this.state.error,next_retry_at:cooldown?.next_retry_at||null}:this.state.error,automation:this._automaticStatus()};}
  status(){return structuredClone({...this.state,...this._statusFields()});}
  summary(){const {report,...state}=this.state;return structuredClone({...state,...this._statusFields()});}
  startAutomatic({canRun=()=>true}={}){
    if(this.closed||this.automatic)return;
    this.automatic=true;this.canRun=canRun;
    const tick=async()=>{
      this.timer=null;
      try{await this.maybeStart();}catch{this.store.event('research.retry_wait','Automatic research will check account and history readiness again.',{},'warning');}
      finally{if(this.automatic&&!this.closed){this.timer=this.setTimer(tick,this.pollInterval);this.timer?.unref?.();}}
    };
    return tick();
  }
  async maybeStart(){if(this._automaticStatus().status==='ready')this.start({automatic:true});}
  start({automatic=false}={}){
    if(this.closed)throw new Error('Research service is shutting down');
    if(busy.has(this.state.status))throw new Error('Research is already running');
    const cooldown=this._cooldown();if(cooldown)throw Object.assign(new Error(`Research is rate limited until ${cooldown.next_retry_at}. Wait for the scheduled retry.`),{status:429});
    if(automatic&&this._accessBlock())return this.status();
    if(!this.engine.connected||!this.engine.broker)throw new Error('Connect Zerodha before collecting historical data');
    const capital=this.engine.capital||this.engine._portfolio?.().reference_assets||0;
    if(!Number.isFinite(capital)||capital<=0)throw new Error('Research needs a verified positive account balance or holding value');
    const config=this.engine.strategy_settings(),interval=config.intraday_enabled?'5minute':'day';
    const intervals=[...(config.intraday_enabled?['5minute']:[]),...(config.swing_enabled?['day']:[])];
    if(!intervals.length)throw new Error('Enable intraday or swing before starting research');
    const broker=this.engine.broker,signature=this.signature(),today=dateIST(this.now()),end=parseTime(today+'T00:00:00+05:30');
    const days=this.settings.research_days*(interval==='day'?7:1),start=new Date(+end-days*86400000);
    const {selected,diversification,scope,blocked_reason}=structuredClone(this._selectionPlan()),universeGeneration=this.engine._universe_generation;
    if(!selected.length)throw new Error(blocked_reason);
    const retry=automatic?this._retry(signature):{signature,failures:0,cancelled:false};
    if(!automatic){this.store.delete('research_access_block');this.blockedBroker=null;}
    this.store.delete('research_auto_signature');
    // Reserve a retry window before requesting data, so restarting during a
    // provider outage cannot reset the backoff into a tight request loop.
    this.store.set('research_auto_retry',{...retry,code:null,cancelled:false,next_retry_at:isoIST(new Date(+this.now()+this._retryDelay(retry.failures)))});
    this.controller=new AbortController();const signal=this.controller.signal,generation=++this.generation;
    const valid=()=>generation===this.generation&&!signal.aborted&&!this.closed&&this.engine.connected&&this.engine.broker===broker&&
      this.engine._universe_generation===universeGeneration&&dateIST(this.now())===today&&
      selected.every(([token,instrument])=>this.engine.universe[token]?.tradingsymbol===instrument.tradingsymbol&&this.engine.universe[token]?.entry_eligible!==false);
    this.state={status:'collecting',progress:0,progress_detail:null,message:'Collecting completed historical candles through the broker rate limiter.',current_task:{title:'Preparing historical research',detail:'Selecting completed historical candles through the broker rate limiter.'},report:this.state.report,started_at:isoIST(this.now()),completed_at:null,error:null,issues:[],comparison:null};
    this.store.event('research.started','Read-only historical strategy comparison started.',{interval,symbols:selected.length,days,strategy_version:STRATEGY_VERSION});
    const backtestOptions=this._backtestOptions(capital),strategyOptions=structuredClone(this.engine._strategy_options());
    this.task=this._runScopes({broker,signature,today,end,start,selected,diversification,scope,interval,capital,signal,generation,intervals,valid,backtestOptions,strategyOptions}).catch(error=>{
      if(!valid())return this._interrupted(generation);
      const failure=researchFailure(error),diagnostic={...failure.diagnostic};
      const next=diagnostic.retryable?isoIST(new Date(+this.now()+Math.max(this._retryDelay(retry.failures),failure.retryAfter))):null;
      diagnostic.next_retry_at=next;
      Object.assign(this.state,{status:'failed',current_task:null,comparison:null,progress_detail:null,message:diagnostic.message,error:diagnostic,completed_at:isoIST(this.now())});
      if(!this.state.issues.some(issue=>issue.code===diagnostic.code&&issue.phase===diagnostic.phase&&issue.symbol===diagnostic.symbol))this._issue(new ResearchFailure(diagnostic));
      this.state.issues=this.state.issues.map(issue=>issue.code===diagnostic.code&&issue.phase===diagnostic.phase&&issue.symbol===diagnostic.symbol?{...issue,next_retry_at:next}:issue);
      this.store.set('research_auto_retry',{signature,code:diagnostic.code,failures:Math.min(21,retry.failures+1),cancelled:false,next_retry_at:next});
      if(diagnostic.code==='rate_limit'){this.store.set('research_rate_limit',{next_retry_at:next});this.cooldownMemo={key:next,expires:this.monotonicNow()+Math.max(this._retryDelay(retry.failures),failure.retryAfter)};}
      if(!diagnostic.retryable){this.blockedBroker=broker;this.store.set('research_access_block',{signature:this._accessSignature(),error:diagnostic,...(diagnostic.code==='worker_timeout'?{runtime_policy:COMPARISON_RUNTIME_POLICY}:{})});}
      this.store.set('research_failure',{error:diagnostic,issues:this.state.issues,completed_at:this.state.completed_at});
      this.store.event('research.failed',diagnostic.message,{...diagnostic},'warning');
    });
    const task=this.task;this.tasks.add(task);task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));
    return this.status();
  }
  async _runScopes(args){
    const reports={};
    for(const [scopeIndex,interval] of args.intervals.entries()){
      if(!args.valid())return this._interrupted(args.generation);
      const start=new Date(+args.end-this.settings.research_days*(interval==='day'?7:1)*86400000);
      const progressSpan=100/args.intervals.length,progressFrom=scopeIndex*progressSpan;
      this.state.status='collecting';this.state.comparison=null;this._currentTask(`Collecting ${interval==='day'?'swing':'intraday'} research candles`);this._progress(progressFrom);
      const report=await this._run({...args,interval,start,progressFrom,progressSpan});if(!report)return;
      this._progress(progressFrom+progressSpan);
      reports[interval]=report;
    }
    if(!args.valid())return this._interrupted(args.generation);
    const primary=reports[args.intervals[0]],others=Object.fromEntries(Object.entries(reports).filter(([key])=>key!==args.intervals[0]));
    if(Object.keys(others).length)primary.alternate_reports=others;
    Object.assign(this.state,{status:'complete',progress:100,current_task:null,comparison:null,progress_detail:null,message:'Research finished. Baseline and enhanced rules were compared on identical historical data.',report:primary,completed_at:isoIST(this.now()),error:null});
    this.store.set('research_report',primary);this.store.set('research_auto_signature',args.signature);this.store.delete('research_auto_retry');this.store.delete('research_failure');this.store.delete('research_access_block');this.blockedBroker=null;
    this.store.event('research.completed',this.state.message,{intervals:args.intervals});
  }
  async _run({broker,signature,today,end,start,selected,diversification,scope,interval,capital,signal,generation,valid,backtestOptions,strategyOptions,progressFrom=0,progressSpan=100}){
    const symbols={},failures=[],issues=[];let index=0,firstFailure=null;
    const progress=fraction=>this._progress(progressFrom+progressSpan*fraction),timeframe=interval==='day'?'daily':'five-minute';
    const historyStage=`${interval==='day'?'Swing':'Intraday'} stock history`;
    for(const [token,instrument] of selected){
      if(!valid())return this._interrupted(generation);
      this._stageProgress(historyStage,index,selected.length,'symbols checked');
      try{
        const key=`research_history:${token}:${interval}`,cache=this.store.get(key,{});
        let rows=cache.date===today&&cache.from===isoIST(start)&&cache.symbol===instrument.tradingsymbol?historyRows(cache.rows,start,end,interval):null;
        if(!rows){
          this._currentTask(`Downloading ${instrument.tradingsymbol} candles`, `Downloading ${timeframe} research candles for ${instrument.tradingsymbol} (${index} of ${selected.length} symbols checked).`);
          rows=await broker.call('historical_data',Number(token),start,new Date(+end-1000),interval);
          if(!valid())return this._interrupted(generation);
          rows=historyRows(rows,start,end,interval);
          if(!rows)throw researchFailure(null,'symbol_history',instrument.tradingsymbol,'data_coverage');
          this.store.set(key,{date:today,from:isoIST(start),symbol:instrument.tradingsymbol,rows});
        }else this._currentTask(`Loading cached ${instrument.tradingsymbol} candles`,`Reusing verified ${timeframe} research candles for ${instrument.tradingsymbol} (${index} of ${selected.length} symbols checked).`);
        if(rows.length)symbols[instrument.tradingsymbol]=rows;else failures.push(instrument.tradingsymbol);
      }catch(error){
        if(!valid())return this._interrupted(generation);
        const failure=this._issue(researchFailure(error,'symbol_history',instrument.tradingsymbol));firstFailure??=failure;
        if(issues.length<issueLimit)issues.push({...failure.diagnostic});failures.push(instrument.tradingsymbol);
        if(['rate_limit','authentication','permission'].includes(failure.diagnostic.code))throw failure;
      }
      progress(++index/selected.length*.45);
      this._stageProgress(historyStage,index,selected.length,'symbols checked');
      this._currentTask(`Checking ${timeframe} stock history`,`Historical data: ${index} of ${selected.length} symbols checked${failures.length?`; ${failures.length} unavailable`:''}.`);
      await sleep(this.delay,signal);
    }
    if(!valid())return this._interrupted(generation);
    if(!Object.keys(symbols).length)throw firstFailure||researchFailure(null,'symbol_history',null,'data_coverage');
    const context=await this._collectContext({broker,selected,start,end,today,interval,valid,issues,onProgress:fraction=>progress(.45+.05*fraction)});
    if(!valid())return this._interrupted(generation);
    const metadata={source:'Kite historical API',selection:scope.mode==='all'?'All eligible current Nifty Total Market constituents. Historical index membership is not reconstructed.':'Reproducible industry-diversified sample drawn only from current Nifty Total Market constituents. Historical index membership is not reconstructed.',universe:scope,diversification,requested_symbols:selected.map(([,i])=>i.tradingsymbol),unavailable_symbols:failures,from:isoIST(start),to:isoIST(new Date(+end-1000)),interval,
      scope:interval==='5minute'?'Intraday strategy comparison only. Overnight strategies require separate daily-data research.':'Swing strategy comparison only.',live_controls:'Market breadth, account holdings, correlation, broker order book and authorization are not reconstructed by this candle simulation.'};
    metadata.context={benchmark:context.benchmark_bars?.length?'NIFTY 50':'unavailable',unavailable:context.unavailable,membership:'Current verified sector membership only; historical membership and historical announcement calendars are not reconstructed.'};
    metadata.issues=issues;
    this.state.status='running';this._currentTask('Preparing strategy comparison','Comparing baseline and enhanced rules on identical historical candles.');this._stageProgress('Preparing strategy comparison');progress(.5);
    const dataset={interval,symbols,metadata,benchmark_bars:context.benchmark_bars,sector_bars:context.sector_bars,symbol_sectors:context.symbol_sectors};
    try {this.worker.start(dataset,{...backtestOptions,enhanced_options:{...strategyOptions,enhanced_signals:true},baseline_options:{enhanced_signals:false},cpu_affinity:this.settings.research_cpu_affinity??'pinned',
      parallelism:this.settings.research_workers??0,reserve_cpus:Math.max(4,this.settings.analytics_reserve_cpus??4),live_workers:this.engine.analytics?.snapshot()?.active_jobs??0});
    }catch(error){throw researchFailure(error,'worker',null,'worker');}
    while(valid()){
      const result=this.worker.status();
      this.state.comparison={phase:result.phase,interval,symbol_count:Object.keys(symbols).length,processed_bars:result.processed_bars,total_bars:result.total_bars,capacity:result.capacity,parallelism:result.parallelism};
      progress(.5+Number(result.progress||0)*.5);
      const phase={baseline:'Simulating baseline rules',enhanced:'Simulating enhanced rules',validating:'Validating historical candles'}[result.phase]||'Comparing baseline and enhanced rules';
      const counts=Number.isSafeInteger(result.processed_bars)&&Number.isSafeInteger(result.total_bars)&&result.total_bars>0?` ${result.processed_bars.toLocaleString('en-IN')} of ${result.total_bars.toLocaleString('en-IN')} candles processed.`:'';
      this._currentTask(`${phase} (${interval==='day'?'swing':'intraday'})`,`${phase} using ${timeframe} candles for ${Object.keys(symbols).length} stocks.${counts}`);
      this._stageProgress(`${phase} (${interval==='day'?'swing':'intraday'})`,result.processed_bars,result.total_bars,'candles',Number.isFinite(result.phase_progress)?result.phase_progress*100:null);
      if(['completed','complete'].includes(result.status)){
        const report=compactReport(result.result??result.report);if(!report)throw researchFailure(null,'worker',null,'worker');
        report.metadata=metadata;report.dataset={...report.dataset,symbols:Object.keys(symbols),errors:failures,requested_from:metadata.from,requested_to:metadata.to,interval};report.completed_at=isoIST(this.now());
        // A completion message can precede the native worker's exit. Retire it
        // before a second enabled interval starts another comparison.
        await this.worker.cancel();
        if(!valid())return this._interrupted(generation);
        return report;
      }
      if(['failed','cancelled'].includes(result.status)){
        const phase=['baseline','enhanced','validating'].includes(result.phase)?`worker_${result.phase}`:'worker';
        throw workerFailure(result,phase);
      }
      await sleep(200,signal);
    }
    this._interrupted(generation);
  }
  async _collectContext({broker,selected,start,end,today,interval,valid,issues=[],onProgress=()=>{}}){
    const result={benchmark_bars:[],sector_bars:{},symbol_sectors:{},unavailable:[]};
    // A synthetic test engine or an older engine without a context service has
    // no verified index identity. Do not guess tokens or industry membership.
    if(!this.engine.market_context?.forSymbol){result.unavailable.push('Market context service unavailable');return result;}
    const names=new Set(['NIFTY 50']);
    for(const [,i] of selected){const info=this.engine.market_context.forSymbol(i.tradingsymbol);
      const sector=info.index_membership.filter(m=>m.status==='fresh'&&!BROAD_INDEX_NAMES.includes(m.index)).sort((a,b)=>a.index.localeCompare(b.index))[0]?.index;
      if(sector){names.add(sector);result.symbol_sectors[i.tradingsymbol]=sector;result.sector_bars[sector]??=[];}
    }
    if(names.size>12)throw researchFailure(null,'context_identity',null,'data_coverage');
    this._currentTask('Looking up benchmark and sector indexes','Downloading benchmark and sector index identities for research.');this._stageProgress('Looking up benchmark and sector indexes');
    let quotes;try{quotes=await broker.call('quote',[...names].map(n=>'NSE:'+n));}catch(error){
      if(!valid())return result;
      const failure=this._issue(researchFailure(error,'context_identity'));if(issues.length<issueLimit)issues.push({...failure.diagnostic});
      if(['rate_limit','authentication','permission'].includes(failure.diagnostic.code))throw failure;result.unavailable.push(...names);return result;
    }
    if(!valid())return result;
    let checked=0;
    for(const name of names){
      this._stageProgress('Benchmark and sector history',checked,names.size,'indexes checked');
      try{
        const token=Number(quotes?.['NSE:'+name]?.instrument_token);if(!Number.isSafeInteger(token)||token<=0)throw researchFailure(null,'context_identity',name,'data_coverage');
        const key=`research_index:${token}:${interval}`,cache=this.store.get(key,{});
        let rows=cache.date===today&&cache.from===isoIST(start)&&cache.symbol===name?historyRows(cache.rows,start,end,interval):null;
        if(!rows){
          this._currentTask(`Downloading ${name} index candles`,`Downloading ${interval==='day'?'daily':'five-minute'} research candles for ${name} (${checked} of ${names.size} indexes checked).`);
          rows=await broker.call('historical_data',token,start,new Date(+end-1000),interval);
          if(!valid())return result;
          rows=historyRows(rows,start,end,interval);
          if(!rows)throw researchFailure(null,'context_history',name,'data_coverage');
          this.store.set(key,{date:today,from:isoIST(start),symbol:name,rows});
        }
        if(name==='NIFTY 50')result.benchmark_bars=rows;else result.sector_bars[name]=rows;
        if(!rows.length)result.unavailable.push(name);
      }catch(error){
        if(!valid())return result;
        const failure=this._issue(researchFailure(error,'context_history',name));if(issues.length<issueLimit)issues.push({...failure.diagnostic});
        if(['rate_limit','authentication','permission'].includes(failure.diagnostic.code))throw failure;result.unavailable.push(name);
      }
      onProgress(++checked/names.size);
      this._stageProgress('Benchmark and sector history',checked,names.size,'indexes checked');
    }
    return result;
  }
  _interrupted(generation=this.generation){if(this.closed||generation!==this.generation)return;this.worker.cancel().catch(()=>{});Object.assign(this.state,{status:'cancelled',current_task:null,comparison:null,progress_detail:null,message:'Research cancelled; previous report retained. Trading settings are unchanged.',completed_at:isoIST(this.now()),error:null});this.store.delete('research_failure');}
  async cancel({suppressAuto=true}={}){
    if(suppressAuto&&!this.closed){const signature=this.signature(),retry=this._retry(signature);
      if(!['idle','complete'].includes(this.state.status)||retry.next_retry_at)this.store.set('research_auto_retry',{...retry,cancelled:true,next_retry_at:null});
    }
    if(!busy.has(this.state.status)){await this.worker.cancel();return this.status();}
    this.generation++;this.controller?.abort();await this.worker.cancel();this._interrupted();return this.status();
  }
  async close(){if(this.closeTask)return this.closeTask;this.closed=true;this.automatic=false;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.controller?.abort();this.closeTask=(async()=>{await this.worker.close();await Promise.allSettled(this.tasks);})();return this.closeTask;}
}
