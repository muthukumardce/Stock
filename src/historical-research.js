import {createHash} from 'node:crypto';
import {ResearchService} from './research.js';
import {STRATEGY_VERSION} from './strategy.js';
import {dateIST,isoIST,parseTime,sleep} from './util.js';

const busy=new Set(['collecting','running']);
const compactRun=run=>run?{...run,trades:(run.trades||[]).slice(-100),equity:(run.equity||[]).filter((_,i,a)=>i%Math.max(1,Math.ceil(a.length/1000))===0||i===a.length-1)}:null;
const compactReport=report=>report?{...report,baseline:compactRun(report.baseline),enhanced:compactRun(report.enhanced)}:null;

/** Account-bound read-only data collection. The worker never receives a broker,
 * credentials, database handle or ability to submit orders. */
export class HistoricalResearch {
  constructor(engine,store,settings,{worker,now=()=>new Date(),delay=500}={}){
    this.engine=engine;this.store=store;this.settings=settings;this.worker=worker||new ResearchService();this.now=now;this.delay=delay;
    const previous=store.get('research_report',null);
    this.state={status:previous?'complete':'idle',progress:0,message:previous?'Previous research report restored.':'Research starts after account connection.',report:previous,started_at:null,completed_at:previous?.completed_at||null};
    this.controller=null;this.task=null;this.closed=false;this.generation=0;
  }
  signature(){return createHash('sha256').update(JSON.stringify([STRATEGY_VERSION,dateIST(this.now()),this.settings.research_symbols,this.settings.research_days,this.engine._strategy_options?.(),this.engine.strategy_settings?.(),this.settings.research_fee_rate,this.settings.research_slippage_rate])).digest('hex');}
  status(){return structuredClone(this.state);}
  async maybeStart(){if(!this.settings.auto_research||this.closed||!this.engine.connected||this.store.get('research_auto_signature')===this.signature()||busy.has(this.state.status))return;try{this.start();}catch{/* A missing account balance is reported by explicit research start. */}}
  start(){
    if(this.closed)throw new Error('Research service is shutting down');
    if(busy.has(this.state.status))throw new Error('Research is already running');
    if(!this.engine.connected||!this.engine.broker)throw new Error('Connect Zerodha before collecting historical data');
    const capital=this.engine.capital||this.engine._portfolio?.().reference_assets||0;
    if(!Number.isFinite(capital)||capital<=0)throw new Error('Research needs a verified positive account balance or holding value');
    const config=this.engine.strategy_settings(),interval=config.intraday_enabled?'5minute':'day';
    const intervals=[...(config.intraday_enabled?['5minute']:[]),...(config.swing_enabled?['day']:[])];
    if(!intervals.length)throw new Error('Enable intraday or swing before starting research');
    const broker=this.engine.broker,signature=this.signature(),today=dateIST(this.now()),end=parseTime(today+'T00:00:00+05:30');
    const days=this.settings.research_days*(interval==='day'?7:1),start=new Date(+end-days*86400000);
    const selected=Object.entries(this.engine.universe).sort((a,b)=>a[1].tradingsymbol.localeCompare(b[1].tradingsymbol)).slice(0,this.settings.research_symbols);
    if(!selected.length)throw new Error('NSE instruments are not available yet');
    this.controller=new AbortController();const signal=this.controller.signal,generation=++this.generation;
    this.state={status:'collecting',progress:0,message:'Collecting completed historical candles through the broker rate limiter.',report:this.state.report,started_at:isoIST(this.now()),completed_at:null};
    this.store.event('research.started','Read-only historical strategy comparison started.',{interval,symbols:selected.length,days,strategy_version:STRATEGY_VERSION});
    this.task=this._runScopes({broker,signature,today,end,start,selected,interval,capital,signal,generation,intervals}).catch(error=>{
      if(signal.aborted||this.closed)return;
      Object.assign(this.state,{status:'failed',message:'Research could not complete. Check historical-data access and dataset coverage; trading settings were not changed.',completed_at:isoIST(this.now())});
      this.store.event('research.failed',this.state.message,{kind:/^[A-Za-z]+$/.test(error.name)?error.name:'Error'},'warning');
    });
    return this.status();
  }
  async _runScopes(args){
    const reports={};
    for(const interval of args.intervals){
      if(args.signal.aborted||this.closed||args.generation!==this.generation)return;
      const start=new Date(+args.end-this.settings.research_days*(interval==='day'?7:1)*86400000);
      this.state.status='collecting';this.state.message=`Collecting ${interval==='day'?'swing':'intraday'} research candles.`;this.state.progress=0;
      const report=await this._run({...args,interval,start});if(!report)return;
      reports[interval]=report;
    }
    if(args.signal.aborted||this.closed||args.generation!==this.generation)return;
    const primary=reports[args.intervals[0]],others=Object.fromEntries(Object.entries(reports).filter(([key])=>key!==args.intervals[0]));
    if(Object.keys(others).length)primary.alternate_reports=others;
    Object.assign(this.state,{status:'complete',progress:100,message:'All enabled strategy comparisons complete. No execution setting was changed.',report:primary,completed_at:primary.completed_at});
    this.store.set('research_report',primary);this.store.set('research_auto_signature',args.signature);
    this.store.event('research.completed',this.state.message,{intervals:args.intervals});
  }
  async _run({broker,signature,today,end,start,selected,interval,capital,signal,generation}){
    const symbols={},failures=[];let index=0;
    const valid=()=>generation===this.generation&&!signal.aborted&&!this.closed&&this.engine.connected&&this.engine.broker===broker;
    for(const [token,instrument] of selected){
      if(!valid())return this._interrupted(generation);
      try{
        const key=`research_history:${token}:${interval}`,cache=this.store.get(key,{});
        let rows=cache.date===today&&cache.from===isoIST(start)?cache.rows:null;
        if(!rows){
          rows=await broker.call('historical_data',Number(token),start,new Date(+end-1000),interval);
          if(!valid())return this._interrupted(generation);
          if(!Array.isArray(rows)||rows.length>5000)throw new Error('Unexpected historical dataset size');
          rows=rows.filter(r=>{const at=parseTime(r.date??r.time);return at&&at>=start&&at<end;}).map(r=>({time:isoIST(parseTime(r.date??r.time)),open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume}));
          this.store.set(key,{date:today,from:isoIST(start),rows});
        }
        if(rows.length)symbols[instrument.tradingsymbol]=rows;else failures.push(instrument.tradingsymbol);
      }catch(error){failures.push(instrument.tradingsymbol);if(error.kind==='TokenException')throw error;}
      this.state.progress=Math.round(++index/selected.length*45);this.state.message=`Historical data: ${index} of ${selected.length} symbols checked.`;
      await sleep(this.delay,signal);
    }
    if(!valid())return this._interrupted(generation);
    if(!Object.keys(symbols).length)throw new Error('No usable historical candles');
    const context=await this._collectContext({broker,selected,start,end,today,interval,valid});
    if(!valid())return this._interrupted(generation);
    const metadata={source:'Kite historical API',selection:'Alphabetical sample of the currently listed NSE equity universe; not representative or survivorship-free.',requested_symbols:selected.map(([,i])=>i.tradingsymbol),unavailable_symbols:failures,from:isoIST(start),to:isoIST(new Date(+end-1000)),interval,
      scope:interval==='5minute'?'Intraday strategy comparison only. Overnight strategies require separate daily-data research.':'Swing strategy comparison only.',live_controls:'Market breadth, account holdings, correlation, broker order book and authorization are not reconstructed by this candle simulation.'};
    metadata.context={benchmark:context.benchmark_bars?.length?'NIFTY 50':'unavailable',unavailable:context.unavailable,membership:'Current verified sector membership only; historical membership and historical announcement calendars are not reconstructed.'};
    this.state.status='running';this.state.message='Comparing baseline and enhanced rules on identical historical candles.';this.state.progress=50;
    this.worker.start({interval,symbols,metadata,benchmark_bars:context.benchmark_bars,sector_bars:context.sector_bars,symbol_sectors:context.symbol_sectors},{initial_capital:capital,risk_per_trade_pct:this.settings.risk_per_trade_pct,max_position_pct:this.settings.max_position_pct,max_positions:this.settings.max_positions,
      fee_rate:this.settings.research_fee_rate,slippage_rate:this.settings.research_slippage_rate,entry_cutoff:this.settings.entry_cutoff,exit_time:this.settings.exit_time,
      enhanced_options:{...this.engine._strategy_options(),enhanced_signals:true},baseline_options:{enhanced_signals:false},max_bars:250000});
    while(valid()){
      const result=this.worker.status();
      this.state.progress=Math.min(99,50+Math.round(Number(result.progress||0)*49));
      if(['completed','complete'].includes(result.status)){
        const report=compactReport(result.result??result.report);if(!report)throw new Error('Worker returned no report');
        report.metadata=metadata;report.dataset={...report.dataset,symbols:Object.keys(symbols),errors:failures,requested_from:metadata.from,requested_to:metadata.to,interval};report.completed_at=isoIST(this.now());
        return report;
      }
      if(['failed','cancelled'].includes(result.status))throw new Error('Research worker did not complete');
      await sleep(200,signal);
    }
    this._interrupted(generation);
  }
  async _collectContext({broker,selected,start,end,today,interval,valid}){
    const result={benchmark_bars:[],sector_bars:{},symbol_sectors:{},unavailable:[]};
    // A synthetic test engine or an older engine without a context service has
    // no verified index identity. Do not guess tokens or industry membership.
    if(!this.engine.market_context){result.unavailable.push('Market context service unavailable');return result;}
    const names=new Set(['NIFTY 50']);
    for(const [,i] of selected){const info=this.engine.market_context.forSymbol(i.tradingsymbol);
      const sector=info.index_membership.filter(m=>m.status==='fresh'&&!['NIFTY 50','NIFTY 500'].includes(m.index)).sort((a,b)=>a.index.localeCompare(b.index))[0]?.index;
      if(sector){names.add(sector);result.symbol_sectors[i.tradingsymbol]=sector;}
    }
    if(names.size>12)throw new Error('Unexpected historical context size');
    let quotes;try{quotes=await broker.call('quote',[...names].map(n=>'NSE:'+n));}catch(error){if(error.kind==='TokenException')throw error;result.unavailable.push(...names);return result;}
    if(!valid())return result;
    for(const name of names){
      try{
        const token=Number(quotes?.['NSE:'+name]?.instrument_token);if(!Number.isSafeInteger(token)||token<=0)throw new Error('Index token unavailable');
        const key=`research_index:${token}:${interval}`,cache=this.store.get(key,{});
        let rows=cache.date===today&&cache.from===isoIST(start)?cache.rows:null;
        if(!rows){
          rows=await broker.call('historical_data',token,start,new Date(+end-1000),interval);
          if(!valid())return result;
          if(!Array.isArray(rows)||rows.length>5000)throw new Error('Unexpected historical context size');
          rows=rows.filter(r=>{const at=parseTime(r.date??r.time);return at&&at>=start&&at<end;}).map(r=>({time:isoIST(parseTime(r.date??r.time)),open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume}));
          this.store.set(key,{date:today,from:isoIST(start),rows});
        }
        if(name==='NIFTY 50')result.benchmark_bars=rows;else result.sector_bars[name]=rows;
        if(!rows.length)result.unavailable.push(name);
      }catch(error){if(error.kind==='TokenException')throw error;result.unavailable.push(name);}
    }
    return result;
  }
  _interrupted(generation=this.generation){if(this.closed||generation!==this.generation)return;this.worker.cancel().catch(()=>{});Object.assign(this.state,{status:'cancelled',message:'Research cancelled; previous report retained. Trading settings are unchanged.',completed_at:isoIST(this.now())});}
  async cancel(){
    if(!busy.has(this.state.status)){await this.worker.cancel();return this.status();}
    this.generation++;this.controller?.abort();await this.worker.cancel();this._interrupted();return this.status();
  }
  async close(){this.closed=true;this.controller?.abort();await this.worker.close();await this.task;}
}
