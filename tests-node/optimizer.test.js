import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizeStrategies,optimizeStrategiesParallel,evaluateOptimizationTask,optimizationPlan} from '../src/optimizer.js';
import {runBacktest} from '../src/backtest.js';
import {ENHANCED_DEFAULTS} from '../src/strategy.js';
import {dateIST} from '../src/util.js';

const DAY=86400000;
function data(interval='5minute',sessions=interval==='day'?100:25){
  const start=+new Date('2025-12-01T09:15:00+05:30');
  return {interval,symbols:{INFY:Array.from({length:sessions},(_,i)=>({time:new Date(start+i*DAY).toISOString(),open:100,high:101,low:99,close:100,volume:1000}))}};
}
const limits={max_candidates:3,max_runtime_ms:60000,min_trades:10,max_drawdown_pct:5};
const options={initial_capital:100000,fee_rate:.001,slippage_rate:.0005,risk_per_trade_pct:.0025,max_position_pct:.1,max_positions:5,strategy_options:{...ENHANCED_DEFAULTS},tuning:limits};
function report(net=100,extra={}){return {metrics:{net_pnl:net,net_return_pct:net/1000,max_drawdown_pct:2,trade_count:20,profit_factor:2,open_positions:0,...extra},data_quality:{gap_count:0,affected_symbol_sessions:0,unresolved_intraday_positions:[],completed_result:true},trades:[]};}
function evaluator(datasets,score){
  const calls=[],ranges=optimizationPlan(datasets).ranges;
  return {calls,runBacktest:(dataset,cfg)=>{const phase=Object.keys(ranges[dataset.interval]).find(phase=>ranges[dataset.interval][phase].from===cfg.score_from);calls.push({dataset,cfg,phase});return score(cfg.strategy_options.min_signal_score,phase,dataset.interval,calls.length);}};
}

test('optimizer requires enough sessions and returns nonoverlapping chronological windows for each interval',()=>{
  assert.equal(optimizationPlan([data('5minute',24)]).eligible,false);
  assert.equal(optimizationPlan([data('day',99)]).eligible,false);
  assert.equal(optimizationPlan([data(),data()]).eligible,false);
  const plan=optimizationPlan([data(),data('day')]);assert.equal(plan.eligible,true);
  for(const ranges of Object.values(plan.ranges)){assert.ok(ranges.train.to<ranges.validation.from);assert.ok(ranges.validation.to<ranges.test.from);}
  const rejected=optimizeStrategies([data('5minute',1)],options,{runBacktest:()=>assert.fail('Insufficient data must not run candidate simulations')});
  assert.equal(rejected.status,'insufficient_data');assert.equal(rejected.holdout_consumed,false);assert.deepEqual(rejected.trials,[]);
});

test('bounded catalogue changes only declared numeric thresholds and preserves all costs, risk, families and directions',()=>{
  const dataset=data(),input=structuredClone(dataset),calls=[];
  const cfg={...options,tuning:{...limits,max_candidates:17},strategy_options:{...ENHANCED_DEFAULTS,enable_reversion:false,intraday_short_enabled:false,technical_exit_enabled:false}};
  const result=optimizeStrategies([dataset],cfg,{runBacktest:(window,settings)=>{calls.push({window,settings});return report(-1);}});
  assert.equal(result.status,'no_improvement');assert.equal(calls.length,17);assert.equal(result.trials.length,17);assert.equal(result.parameters,null);
  const allowed=new Set(['min_signal_score','min_adx','min_setup_volume','max_atr_extension']);
  for(const trial of result.trials){assert.ok(Object.keys(trial.parameters).every(key=>allowed.has(key)));assert.ok(Object.keys(trial.parameters).length<=1);}
  for(const {settings} of calls){for(const key of ['initial_capital','fee_rate','slippage_rate','risk_per_trade_pct','max_position_pct','max_positions'])assert.equal(settings[key],cfg[key]);for(const key of ['enable_reversion','intraday_short_enabled','technical_exit_enabled'])assert.equal(settings.strategy_options[key],false);}
  assert.deepEqual(dataset,input);
});

test('candidate training cannot see validation/test rows and validation receives no final-test rows',()=>{
  const datasets=[data()],spy=evaluator(datasets,(parameter)=>report(parameter===60?100:parameter===65?300:200));
  const progress=[],result=optimizeStrategies(datasets,options,{...spy,onProgress:update=>progress.push(update)});
  assert.equal(result.status,'accepted');assert.deepEqual(result.parameters,{min_signal_score:65});assert.equal(result.selected_id,'candidate_1');assert.equal(result.holdout_consumed,true);
  for(const {dataset,cfg,phase} of spy.calls){const boundary=result.ranges[dataset.interval][phase];assert.equal(cfg.score_from,boundary.from);assert.equal(cfg.score_to,boundary.to);assert.ok(Object.values(dataset.symbols).flat().every(row=>dateIST(new Date(row.time))<=boundary.to));assert.equal(cfg.initial_capital,100000);}
  assert.ok(progress.every(update=>Number.isInteger(update.trial)&&update.trial>=1&&update.trial<=update.trial_count));assert.ok(progress.every(update=>update.progress>=0&&update.progress<=1));
});

test('final-test failure does not evaluate or promote the validation runner-up',()=>{
  const datasets=[data()],spy=evaluator(datasets,(parameter,phase)=>report(parameter===60?100:parameter===65?(phase==='test'?-200:400):300));
  const result=optimizeStrategies(datasets,options,spy);
  assert.equal(result.status,'no_improvement');assert.equal(result.selected_id,'candidate_1');assert.equal(result.parameters,null);assert.equal(result.holdout_consumed,true);
  assert.deepEqual(spy.calls.filter(call=>call.phase==='test').map(call=>call.cfg.strategy_options.min_signal_score),[60,65]);
  assert.equal(result.trials.find(trial=>trial.id==='candidate_2').test,undefined);
});

test('reserved final-test dates still produce real parameter training and validation results in both executors',async()=>{
  const datasets=[data(),data('day')],settings={...options,final_test_allowed:false};
  const {result,calls,phases}=await faultComparison(parameter=>report(parameter===60?100:parameter===65?300:200),{datasets,settings});
  assert.equal(result.status,'waiting_for_fresh_data');assert.equal(result.final_test_allowed,false);assert.equal(result.holdout_consumed,false);
  assert.equal(result.parameters,null);assert.equal(result.selected_id,'candidate_1');assert.equal(result.failed_trials,0);
  assert.deepEqual(phases,['tuning_train','tuning_validation']);assert.equal(calls.length,12);assert.ok(calls.every(call=>call.phase!=='test'));
  assert.equal(result.trials[1].status,'final_test_pending');assert.match(result.trials[1].reason,/fresh final-test dates/);
  for(const trial of result.trials){
    assert.equal(trial.test,undefined);
    for(const interval of ['5minute','day']){assert.ok(trial.train[interval].metrics.trade_count>0);assert.ok(trial.validation[interval].metrics.net_pnl>0);}
  }
  for(const {cfg,dataset} of calls){
    assert.equal(Object.hasOwn(cfg,'final_test_allowed'),false,'Internal holdout permission is not a strategy/backtest parameter');
    assert.ok(Object.values(dataset.symbols).flat().every(row=>dateIST(new Date(row.time))<result.ranges[dataset.interval].test.from));
    for(const key of ['fee_rate','slippage_rate','risk_per_trade_pct','max_position_pct','max_positions'])assert.equal(cfg[key],settings[key]);
  }
});

test('repeating a comparison on already reserved dates retains stage evidence without consuming or retrying its final test',()=>{
  const datasets=[data()],score=parameter=>report(parameter===60?100:300),initialSpy=evaluator(datasets,score),repeatSpy=evaluator(datasets,score);
  const initial=optimizeStrategies(datasets,options,initialSpy),repeat=optimizeStrategies(datasets,{...options,final_test_allowed:false},repeatSpy);
  assert.equal(initial.status,'accepted');assert.equal(initial.final_test_allowed,true);assert.equal(initial.holdout_consumed,true);
  assert.equal(repeat.status,'waiting_for_fresh_data');assert.equal(repeat.parameters,null);assert.equal(repeat.holdout_consumed,false);
  assert.deepEqual(repeat.trials.map(trial=>[trial.parameter_set_id,trial.train,trial.validation]),initial.trials.map(trial=>[trial.parameter_set_id,trial.train,trial.validation]));
  assert.equal(repeatSpy.calls.some(call=>call.phase==='test'),false);
});

for(const stage of ['train','validation'])test(`without a fresh holdout, failing ${stage} quality reports no improvement instead of implying a qualified finalist`,async()=>{
  const {result,calls,phases}=await faultComparison((parameter,phase)=>report(phase===stage?-100:parameter===60?100:300),{settings:{...options,final_test_allowed:false}});
  assert.equal(result.status,'no_improvement');assert.equal(result.final_test_allowed,false);assert.equal(result.selected_id,null);assert.equal(result.parameters,null);assert.equal(result.holdout_consumed,false);
  assert.ok(result.trials.every(trial=>trial.train));assert.ok(calls.every(call=>call.phase!=='test'));assert.ok(!phases.includes('tuning_test'));
  if(stage==='validation')assert.ok(result.trials.every(trial=>trial.validation));
});

for(const phase of ['train','validation'])test(`a ${phase} calculation error keeps its successful siblings visible while a fresh final test remains blocked`,async()=>{
  const {result,calls,phases}=await faultComparison((parameter,current)=>{if(parameter===65&&current===phase)throw fixtureCandidateError();return report(parameter===60?100:300);},{settings:{...options,final_test_allowed:false}});
  assert.equal(result.status,'waiting_for_fresh_data');assert.equal(result.failed_trials,1);assert.equal(result.final_test_allowed,false);assert.equal(result.holdout_consumed,false);
  assert.equal(result.parameters,null);assert.equal(result.selected_id,'candidate_2');assertCandidateError(result.trials[1],phase);
  assert.equal(result.trials[2].status,'final_test_pending');assert.equal(result.trials[2].validation['5minute'].metrics.net_pnl,300);
  assert.ok(calls.every(call=>call.phase!=='test'));assert.deepEqual(phases,['tuning_train','tuning_validation']);
  if(phase==='validation')assert.ok(result.trials[1].train);
});

test('an unavailable starting-set comparison retains the calculation-error verdict even when the final test is blocked',async()=>{
  const {result,calls}=await faultComparison(parameter=>{if(parameter===60)throw fixtureCandidateError();return report(300);},{settings:{...options,final_test_allowed:false}});
  assert.equal(result.status,'completed_with_errors');assert.equal(result.failed_trials,1);assert.equal(result.final_test_allowed,false);assert.equal(result.parameters,null);
  assert.ok(result.trials[1].train);assert.ok(result.trials[2].train);assert.ok(calls.every(call=>call.phase==='train'));
});

test('internal final-test permission accepts only booleans and defaults to enabled',async()=>{
  for(const value of [null,0,1,'false',{},[]]){
    assert.throws(()=>optimizeStrategies([data()],{...options,final_test_allowed:value}),/boolean/);
    await assert.rejects(optimizeStrategiesParallel([data()],{...options,final_test_allowed:value}),/boolean/);
  }
  const result=optimizeStrategies([data('5minute',1)],{...options,final_test_allowed:false});
  assert.equal(result.status,'insufficient_data');assert.equal(result.final_test_allowed,false);assert.equal(result.holdout_consumed,false);
});

test('one global parameter candidate must pass every enabled interval',()=>{
  const datasets=[data(),data('day')],spy=evaluator(datasets,(parameter,phase,interval)=>report(parameter===60?100:parameter===65?(phase==='test'&&interval==='day'?-100:300):200));
  const result=optimizeStrategies(datasets,options,spy);assert.equal(result.status,'no_improvement');assert.equal(result.parameters,null);
  assert.match(result.trials.find(trial=>trial.id==='candidate_1').reason,/day/);assert.equal(spy.calls.filter(call=>call.phase==='test').length,4);
});

for(const [label,alter] of [
  ['too few closed trades',r=>{r.metrics.trade_count=9;}],
  ['undefined profit factor',r=>{r.metrics.profit_factor=null;}],
  ['excessive drawdown',r=>{r.metrics.max_drawdown_pct=6;}],
  ['unresolved exposure',r=>{r.data_quality.completed_result=false;r.data_quality.unresolved_intraday_positions=['INFY'];}],
  ['an open overnight book',r=>{r.metrics.open_positions=1;}],
  ['gap-affected trade',r=>{r.trades=[{data_gap:true}];}],
])test(`optimizer cannot promote a result with ${label}`,()=>{
  const datasets=[data()],spy=evaluator(datasets,()=>{const result=report();alter(result);return result;});
  const result=optimizeStrategies(datasets,options,spy);assert.equal(result.status,'no_improvement');assert.equal(result.holdout_consumed,false);assert.equal(result.parameters,null);
});

test('a more profitable validation result is rejected when drawdown worsens against the incumbent',()=>{
  const datasets=[data()],spy=evaluator(datasets,(parameter,phase)=>report(parameter===60?100:200,{max_drawdown_pct:parameter!==60&&phase==='validation'?3:2}));
  const result=optimizeStrategies(datasets,options,spy);assert.equal(result.status,'no_improvement');assert.equal(result.holdout_consumed,false);assert.equal(spy.calls.some(call=>call.phase==='test'),false);
});

for(const [label,alter] of [['an open position',report=>{report.metrics.open_positions=1;}],['gap-affected trades',report=>{report.trades=[{data_gap:true}];}]])test(`incumbent final-test ${label} prevents a misleading relative improvement claim`,()=>{
  const datasets=[data()],spy=evaluator(datasets,(parameter,phase)=>{const r=report(parameter===60?100:200);if(parameter===60&&phase==='test')alter(r);return r;});
  const result=optimizeStrategies(datasets,options,spy);assert.equal(result.status,'no_improvement');assert.equal(result.holdout_consumed,true);assert.match(result.trials.find(trial=>trial.id===result.selected_id).reason,/incumbent comparison/);assert.equal(result.parameters,null);
});

test('budget exhaustion produces no winner and cancellation remains interruptible',()=>{
  let elapsed=0,calls=0;
  const result=optimizeStrategies([data()],{...options,tuning:{...limits,max_runtime_ms:1000}},{now:()=>elapsed,runBacktest:()=>{calls++;elapsed+=600;return report();}});
  assert.equal(result.status,'budget_exhausted');assert.equal(result.parameters,null);assert.equal(calls,2);assert.equal(result.holdout_consumed,false);
  assert.throws(()=>optimizeStrategies([data()],options,{cancelled:()=>true}),error=>error.name==='AbortError');
});

test('an interrupted final test remains consumed and cannot return a partially selected winner',()=>{
  let elapsed=0;const datasets=[data()],spy=evaluator(datasets,(parameter,phase)=>{if(phase==='test')elapsed=2000;return report(parameter===60?100:200);});
  const result=optimizeStrategies(datasets,{...options,tuning:{...limits,max_runtime_ms:1000}},{...spy,now:()=>elapsed});
  assert.equal(result.status,'budget_exhausted');assert.equal(result.holdout_consumed,true);assert.equal(result.parameters,null);
});

function session(date){
  const start=+new Date(date+'T09:15:00+05:30');
  return Array.from({length:75},(_,i)=>{const price=i<20?100:100.6;return {time:new Date(start+i*300000).toISOString(),open:i===20?100.1:price,high:i===20?100.6:price+.1,low:i===20?100.1:price-.1,close:price,volume:i===20?3000:1000};});
}
test('backtest scoring windows do not carry warmup trades, capital or costs into validation',()=>{
  const prior=session('2026-09-14'),scored=session('2026-09-15'),future=session('2026-09-16'),costs={fee_rate:.001,slippage_rate:.0005};
  const dataset={interval:'5minute',symbols:{INFY:[...prior,...scored,...future]}};
  const window=runBacktest(dataset,{...costs,score_from:'2026-09-15',score_to:'2026-09-15'}),independent=runBacktest({interval:'5minute',symbols:{INFY:scored}},costs);
  assert.deepEqual(window.metrics,independent.metrics);assert.deepEqual(window.trades,independent.trades);assert.equal(window.dataset.warmup_bar_count,75);assert.equal(window.dataset.bar_count,75);
  assert.ok(window.equity.every(point=>dateIST(new Date(point.timestamp))==='2026-09-15'));assert.equal(window.metrics.initial_capital,100000);
});

test('warmup signals cannot create a position at the first scored daily opening',()=>{
  const start=+new Date('2026-06-01T09:15:00+05:30'),rows=Array.from({length:57},(_,i)=>({time:new Date(start+i*DAY).toISOString(),open:100,high:100.2,low:99.8,close:100,volume:1000}));
  Object.assign(rows[54],{open:100,high:101.05,low:99.95,close:101,volume:4000});Object.assign(rows[55],{open:101,high:101.1,low:100.8,close:101});Object.assign(rows[56],{open:101,high:101.1,low:100.8,close:101});
  const dataset={interval:'day',symbols:{INFY:rows}},full=runBacktest(dataset,{fee_rate:0,slippage_rate:0});assert.equal(full.open_positions.length,1);
  const from=dateIST(new Date(rows[55].time)),window=runBacktest(dataset,{fee_rate:0,slippage_rate:0,score_from:from});
  assert.equal(window.open_positions.length,0);assert.equal(window.trades.length,0);assert.equal(window.metrics.net_pnl,0);
});

test('optimizer actual calculation rejects a flat data sample without manufacturing profitable trades',()=>{
  const result=optimizeStrategies([data()],{...options,tuning:{...limits,max_candidates:3}});
  assert.equal(result.status,'no_improvement');assert.equal(result.parameters,null);assert.equal(result.trials.length,3);assert.ok(result.trials.every(trial=>trial.train['5minute'].metrics.trade_count===0));
});

test('indicator-only warmup preserves prior-session evidence for an early scored intraday signal',()=>{
  const previousStart=+new Date('2026-09-16T09:15:00+05:30'),start=+new Date('2026-09-17T09:15:00+05:30');
  const closes=Array.from({length:75},(_,i)=>100+(i-74)*.005+Math.sin(i*.8)*.2),adjustment=closes.at(-1)-100;
  const previous=closes.map((value,i)=>{const close=value-adjustment,open=i?closes[i-1]-adjustment:close-.02;return {time:new Date(previousStart+i*300000).toISOString(),open,high:Math.max(open,close)+.05,low:Math.min(open,close)-.05,close,volume:1000};});
  const today=[];for(let i=0;i<75;i++){const close=[100.22,100.34,100.46][i]??100.46,open=i?today.at(-1).close:100.1;today.push({time:new Date(start+i*300000).toISOString(),open,high:Math.max(open,close)+.02,low:Math.min(open,close)-.02,close,volume:i<3?2500:1000});}
  const strategy_options={...ENHANCED_DEFAULTS,...Object.fromEntries(Object.keys(ENHANCED_DEFAULTS).filter(key=>key.startsWith('enable_')).map(key=>[key,false])),enable_opening_drive:true,intraday_short_enabled:false,higher_timeframe_filter:true,technical_exit_enabled:false};
  const cfg={fee_rate:0,slippage_rate:0,strategy_options,score_from:'2026-09-17',score_to:'2026-09-17'},full=runBacktest({interval:'5minute',symbols:{INFY:[...previous,...today]}},cfg);
  const early=full.trades.find(trade=>trade.entry_time===today[3].time);assert.ok(early);assert.equal(early.setup,'opening_drive');assert.equal(full.dataset.warmup_bar_count,75);
  const without=runBacktest({interval:'5minute',symbols:{INFY:today}},cfg);assert.equal(without.trades.some(trade=>trade.entry_time===today[3].time),false);assert.ok(full.trades.every(trade=>dateIST(new Date(trade.entry_time))==='2026-09-17'));
});

test('P labels expose complete effective thresholds while preserving the existing patch contract',()=>{
  const result=optimizeStrategies([data()],options,{runBacktest:()=>report(-1)});
  assert.deepEqual(result.trials.map(trial=>trial.parameter_set_id),['P1','P2','P3']);
  for(const trial of result.trials){
    assert.deepEqual(Object.keys(trial.effective_parameters),['min_signal_score','min_adx','min_setup_volume','max_atr_extension']);
    for(const [key,value] of Object.entries(trial.effective_parameters))assert.equal(value,trial.parameters[key]??options.strategy_options[key]);
  }
  assert.equal(result.trials[1].status,'rejected');assert.ok(result.trials[1].train);assert.deepEqual(result.trials[0].parameters,{});
});

for(const count of [50,100])test(`${count} predeclared parameter sets remain distinct and preserve the original 17-set prefix`,()=>{
  const run=max_candidates=>optimizeStrategies([data()],{...options,tuning:{...limits,max_candidates}},{runBacktest:()=>report(-1)});
  const prefix=run(17),result=run(count);
  assert.equal(result.trials.length,count);assert.deepEqual(result.trials.slice(0,17),prefix.trials);
  assert.equal(new Set(result.trials.map(trial=>JSON.stringify(trial.effective_parameters))).size,count);
  for(const [index,trial] of result.trials.entries()){
    assert.equal(trial.parameter_set_id,`P${index+1}`);
    assert.ok(Object.keys(trial.parameters).every(key=>['min_signal_score','min_adx','min_setup_volume','max_atr_extension'].includes(key)));
  }
  const extreme=optimizeStrategies([data()],{...options,strategy_options:{...options.strategy_options,min_signal_score:100,min_adx:60,min_setup_volume:10,max_atr_extension:10},tuning:{...limits,max_candidates:count}},{runBacktest:()=>report(-1)});
  assert.equal(extreme.trials.length,count);assert.equal(new Set(extreme.trials.map(trial=>JSON.stringify(trial.effective_parameters))).size,count);
});

for(const count of [50,100])test(`${count}-set parallel ordering agrees with sequential selection and respects its assigned worker capacity`,async()=>{
  const workers=Math.floor(count*.8),datasets=[data()],settings={...options,parallelism:workers,tuning:{...limits,max_candidates:count}};
  const score=parameter=>report(parameter===60?100:200),serialSpy=evaluator(datasets,score),parallelSpy=evaluator(datasets,score);
  const expected=optimizeStrategies(datasets,settings,serialSpy);let workerLimit;
  const actual=await optimizeStrategiesParallel(datasets,settings,{poolFactory:(context,capacity)=>{workerLimit=capacity.workerLimit;return {
    async runBatch(tasks,{prepare,onComplete,onProgress}){let completed=0;for(const task of [...tasks].reverse()){onComplete(task,evaluateOptimizationTask(context,prepare(task),parallelSpy));completed++;onProgress({worker_limit:workers,active_workers:0,completed_tasks:completed,total_tasks:tasks.length,active_sets:[]});}},async close(){},
  };}});
  assert.equal(workerLimit,workers);assert.deepEqual({...actual,elapsed_ms:0},{...expected,elapsed_ms:0});
});

test('out-of-order parallel phase completions preserve the same finalist and never test a runner-up',async()=>{
  const datasets=[data()],score=(parameter,phase)=>report(parameter===60?100:parameter===65?(phase==='test'?-200:400):300);
  const serialSpy=evaluator(datasets,score),parallelSpy=evaluator(datasets,score);
  const expected=optimizeStrategies(datasets,options,serialSpy),phases=[];let retired=false;
  const actual=await optimizeStrategiesParallel(datasets,{...options,parallelism:3},{poolFactory:context=>({
    async runBatch(tasks,{prepare,onComplete,onProgress}){
      phases.push(tasks[0].phase);let completed=0;
      for(const task of [...tasks].reverse()){
        const stage=evaluateOptimizationTask(context,prepare(task),parallelSpy);onComplete(task,stage);completed++;
        onProgress({worker_limit:3,active_workers:0,completed_tasks:completed,total_tasks:tasks.length,active_sets:[]});
      }
    },async close(){retired=true;},
  })});
  assert.equal(retired,true);assert.deepEqual(phases,['tuning_train','tuning_validation','tuning_test']);
  assert.deepEqual({...actual,elapsed_ms:0},{...expected,elapsed_ms:0});
  assert.deepEqual(parallelSpy.calls.filter(call=>call.phase==='test').map(call=>call.cfg.strategy_options.min_signal_score).sort(),[60,65]);
});

function parallelData(symbolCount=1,barsPerSession=8){
  const start=+new Date('2025-12-01T09:15:00+05:30'),rows=[];
  for(let day=0;day<25;day++)for(let bar=0;bar<barsPerSession;bar++)rows.push({time:new Date(start+day*DAY+bar*300000).toISOString(),open:100,high:100.05,low:99.95,close:100,volume:1000});
  return {interval:'5minute',symbols:Object.fromEntries(Array.from({length:symbolCount},(_,index)=>[`SYMBOL${index}`,structuredClone(rows)]))};
}

test('a 150-stock research plan accepts more than the former 250000-bar limit',()=>{
  const dataset=parallelData(150,75);
  assert.equal(Object.values(dataset.symbols).reduce((sum,rows)=>sum+rows.length,0),281250);
  assert.equal(optimizationPlan([dataset]).eligible,true);
});

test('real candidate processes evaluate parameter sets concurrently and match sequential metrics deterministically',async()=>{
  const dataset=parallelData(1,30),before=structuredClone(dataset),events=[],progress=[];
  const expected=optimizeStrategies([dataset],options);
  const actual=await optimizeStrategiesParallel([dataset],{...options,parallelism:3},{onWorkerEvent:event=>events.push(event),onProgress:update=>progress.push(update)});
  assert.deepEqual({...actual,elapsed_ms:0},{...expected,elapsed_ms:0});assert.deepEqual(dataset,before);
  const created=events.filter(event=>event.type==='created').map(event=>event.process_id),stopped=events.filter(event=>event.type==='stopped').map(event=>event.process_id);
  assert.equal(new Set(created).size,3);assert.ok(created.every(id=>Number.isInteger(id)&&id>0&&id!==process.pid));assert.deepEqual(stopped.sort(),created.sort());
  assert.ok(progress.some(update=>update.parallelism.active_processes===3));
  assert.ok(progress.some(update=>update.parallelism.active_threads>0));
  assert.ok(progress.some(update=>update.parallelism.workers.some(worker=>worker.process_id>0&&worker.worker_id>0)));
  assert.ok(progress.some(update=>update.trials.some(trial=>trial.train)&&update.parallelism.completed_tasks<3));
  assert.equal(progress.at(-1).parallelism.active_workers,0);assert.equal(progress.at(-1).parallelism.completed_tasks,3);
  assert.ok(progress.every(update=>update.parallelism.active_workers<=3&&update.parallelism.active_sets.every(set=>/^P[1-3]$/.test(set.parameter_set_id))));
});

test('cancellation stops dispatch and joins all real optimizer workers before rejecting',async()=>{
  let cancellation=false;const events=[];
  await assert.rejects(optimizeStrategiesParallel([parallelData(4,75)],{...options,parallelism:3},{cancelled:()=>cancellation,onWorkerEvent:event=>{events.push(event);if(event.type==='task_started')cancellation=true;}}),error=>error.name==='AbortError');
  const created=events.filter(event=>event.type==='created'),stopped=events.filter(event=>event.type==='stopped');
  assert.ok(created.length>=1&&created.length<=3);assert.deepEqual(stopped.map(event=>event.process_id).sort(),created.map(event=>event.process_id).sort());
  assert.equal(events.filter(event=>event.type==='task_complete').length,0);
});

test('parallel budget exhaustion keeps completed sets but cannot retain or promote an active worker result',async()=>{
  const events=[];
  const result=await optimizeStrategiesParallel([parallelData(5,75)],{...options,parallelism:3,tuning:{...limits,max_runtime_ms:150}},{onWorkerEvent:event=>events.push(event)});
  assert.equal(result.status,'budget_exhausted');assert.equal(result.parameters,null);assert.equal(result.holdout_consumed,false);
  assert.deepEqual(events.filter(event=>event.type==='stopped').map(event=>event.process_id).sort(),events.filter(event=>event.type==='created').map(event=>event.process_id).sort());
});

test('malformed data produces independent candidate errors and retires every real worker after all sets finish',async()=>{
  const dataset=parallelData(),events=[],progress=[];dataset.symbols.SYMBOL0[0].high=90;
  const expected=optimizeStrategies([dataset],options),result=await optimizeStrategiesParallel([dataset],{...options,parallelism:2},{onWorkerEvent:event=>events.push(event),onProgress:update=>progress.push(update)});
  assert.deepEqual({...result,elapsed_ms:0},{...expected,elapsed_ms:0});
  assert.equal(result.status,'completed_with_errors');assert.equal(result.failed_trials,3);assert.equal(result.parameters,null);assert.equal(result.holdout_consumed,false);
  assert.equal(result.trials.length,3);assert.ok(result.trials.every(trial=>trial.status==='error'&&trial.error.phase==='train'&&trial.error.code==='candidate_error'));
  assert.equal(events.filter(event=>event.type==='created').length,3,'Each attempted parameter set gets a fresh isolated process');
  assert.equal(events.filter(event=>event.type==='task_started').length,3,'A later queued set must still run after another set fails');
  assert.equal(progress.at(-1).parallelism.completed_tasks,3);assert.equal(progress.at(-1).parallelism.failed_tasks,3);
  assert.ok(progress.some(update=>update.trials.some(trial=>trial.error)&&update.parallelism.completed_tasks<3));
  assert.deepEqual(events.filter(event=>event.type==='stopped').map(event=>event.process_id).sort(),events.filter(event=>event.type==='created').map(event=>event.process_id).sort());
});

async function faultComparison(score,{datasets=[data()],settings=options}={}){
  const serial=evaluator(datasets,score),parallel=evaluator(datasets,score),phases=[];let retired=false;
  const expected=optimizeStrategies(datasets,settings,serial);
  const actual=await optimizeStrategiesParallel(datasets,{...settings,parallelism:3},{poolFactory:context=>({
    async runBatch(tasks,{prepare,onComplete,onFailure,onProgress}){
      phases.push(tasks[0].phase);let completed=0;
      for(const task of [...tasks].reverse()){
        let stage,failed;try{stage=evaluateOptimizationTask(context,prepare(task),parallel);}catch(error){failed=error;}
        if(failed){if(failed.optimizationBudget||failed.name==='AbortError')throw failed;onFailure(task,failed);}else onComplete(task,stage);
        completed++;onProgress({worker_limit:3,active_workers:0,completed_tasks:completed,total_tasks:tasks.length,active_sets:[]});
      }
    },async close(){retired=true;},
  })});
  assert.equal(retired,true);assert.deepEqual({...actual,elapsed_ms:0},{...expected,elapsed_ms:0},'Worker completion order must not change selection or error evidence');
  return {result:actual,calls:parallel.calls,phases};
}

const fixtureCandidateError=()=>Object.assign(new Error('Candidate fixture could not finish its calculation.'),{private_token:'secret_detail'});

function assertCandidateError(trial,phase,code='candidate_error'){
  assert.equal(trial.status,'error');assert.equal(trial.error.phase,phase);assert.equal(trial.error.code,code);
  assert.equal(typeof trial.error.message,'string');assert.ok(trial.error.message.length>0);assert.equal(typeof trial.reason,'string');assert.ok(trial.reason.length>0);
  assert.doesNotMatch(JSON.stringify(trial.error),/private_token|secret_detail/);
  assert.ok(Object.keys(trial.error).every(key=>['phase','interval','code','message'].includes(key)));
}

for(const phase of ['train','validation'])test(`a challenger ${phase} error preserves successful siblings and can still accept a fully qualified winner`,async()=>{
  const {result,calls}=await faultComparison((parameter,current)=>{if(parameter===65&&current===phase)throw fixtureCandidateError();return report(parameter===60?100:parameter===65?400:300);});
  assert.equal(result.status,'accepted');assert.equal(result.failed_trials,1);assert.equal(result.selected_id,'candidate_2');assert.deepEqual(result.parameters,{min_signal_score:55});
  const failed=result.trials[1],winner=result.trials[2];assertCandidateError(failed,phase);assert.equal(failed[phase],undefined);
  if(phase==='validation')assert.equal(failed.train['5minute'].metrics.net_pnl,400);
  for(const stage of ['train','validation','test'])assert.equal(winner[stage]['5minute'].metrics.net_pnl,300);
  assert.ok(calls.some(call=>call.cfg.strategy_options.min_signal_score===55&&call.phase===phase));
  assert.equal(calls.some(call=>call.cfg.strategy_options.min_signal_score===65&&call.phase==='test'),false);
});

for(const phase of ['train','validation'])test(`an incumbent ${phase} error lets siblings finish that phase but prevents unsupported promotion`,async()=>{
  const {result,calls,phases}=await faultComparison((parameter,current)=>{if(parameter===60&&current===phase)throw fixtureCandidateError();return report(parameter===60?100:parameter===65?400:300);});
  assert.equal(result.status,'completed_with_errors');assert.equal(result.failed_trials,1);assert.equal(result.parameters,null);assert.equal(result.holdout_consumed,false);
  assertCandidateError(result.trials[0],phase);
  if(phase==='validation')assert.equal(result.trials[0].train['5minute'].metrics.net_pnl,100);
  assert.equal(calls.filter(call=>call.phase===phase).length,3);
  assert.ok(result.trials.slice(1).every(trial=>trial[phase]?.['5minute'].metrics.net_pnl>0));
  assert.equal(calls.some(call=>call.phase==='test'),false);
  assert.deepEqual(phases,phase==='train'?['tuning_train']:['tuning_train','tuning_validation']);
});

for(const who of ['finalist','incumbent'])test(`${who==='incumbent'?'an':'a'} ${who} final-test error keeps prior evidence and never tries the validation runner-up`,async()=>{
  const failedParameter=who==='finalist'?65:60;
  const {result,calls}=await faultComparison((parameter,phase)=>{if(parameter===failedParameter&&phase==='test')throw fixtureCandidateError();return report(parameter===60?100:parameter===65?400:300);});
  assert.equal(result.status,'completed_with_errors');assert.equal(result.failed_trials,1);assert.equal(result.parameters,null);assert.equal(result.selected_id,'candidate_1');assert.equal(result.holdout_consumed,true);
  const failed=result.trials[who==='finalist'?1:0];assertCandidateError(failed,'test');
  assert.ok(failed.train?.['5minute']);assert.ok(failed.validation?.['5minute']);assert.equal(failed.test,undefined);
  assert.deepEqual(calls.filter(call=>call.phase==='test').map(call=>call.cfg.strategy_options.min_signal_score).sort(),[60,65]);
  assert.equal(result.trials[2].test,undefined);
  const healthy=result.trials[who==='finalist'?0:1];assert.ok(healthy.test?.['5minute']);
});

test('failed challengers and losing completed sets remain visible without producing a partial winner',async()=>{
  const {result,calls}=await faultComparison(parameter=>{if(parameter===65)throw fixtureCandidateError();return report(-100);});
  assert.equal(result.status,'completed_with_errors');assert.equal(result.failed_trials,1);assert.equal(result.parameters,null);assert.equal(result.holdout_consumed,false);
  assertCandidateError(result.trials[1],'train');assert.equal(result.trials[2].status,'rejected');assert.equal(result.trials[2].train['5minute'].metrics.net_pnl,-100);assert.equal(calls.length,3);
});

test('an individual backtest timeout is isolated while the larger search still has time for other sets',async()=>{
  const settings={...options,tuning:{...limits,max_runtime_ms:1200000}};
  const {result,calls}=await faultComparison(parameter=>{if(parameter===65)throw new Error('Backtest runtime limit exceeded; use a smaller dataset');return report(-100);},{settings});
  assert.equal(result.status,'completed_with_errors');assert.equal(result.failed_trials,1);assert.equal(result.parameters,null);
  assertCandidateError(result.trials[1],'train','candidate_timeout');assert.equal(calls.length,3);
  assert.ok(calls.every(call=>call.cfg.max_runtime_ms===600000));assert.equal(result.trials[2].train['5minute'].metrics.net_pnl,-100);
});

test('a failure in the second enabled interval identifies that interval without invalidating other parameter sets',async()=>{
  const {result,calls}=await faultComparison((parameter,phase,interval)=>{if(parameter===65&&phase==='train'&&interval==='day')throw fixtureCandidateError();return report(parameter===60?100:300);},{datasets:[data(),data('day')]});
  assert.equal(result.status,'accepted');assert.equal(result.failed_trials,1);assert.equal(result.selected_id,'candidate_2');assertCandidateError(result.trials[1],'train');
  assert.equal(result.trials[1].error.interval,'day');
  for(const interval of ['5minute','day'])assert.equal(result.trials[2].test[interval].metrics.net_pnl,300);
  assert.ok(calls.some(call=>call.phase==='train'&&call.dataset.interval==='day'&&call.cfg.strategy_options.min_signal_score===55));
});

function progressContext(datasets){
  return {datasets,common:{initial_capital:100000,fee_rate:.001,slippage_rate:.0005},incumbent:{...ENHANCED_DEFAULTS},limits,ranges:optimizationPlan(datasets).ranges};
}
const progressTask={trial:{id:'incumbent',parameter_set_id:'P1',parameters:{}},phase:'tuning_train',remaining_ms:60000};

test('candidate progress comes from actual processed backtest bars and reaches one only after the report succeeds',()=>{
  const dataset=parallelData(1,30),updates=[];
  const stage=evaluateOptimizationTask(progressContext([dataset]),progressTask,{onProgress:update=>updates.push(update)});
  assert.ok(stage['5minute']);assert.equal(updates[0].progress,0);assert.equal(updates[0].processed_bars,0);assert.equal(updates[0].total_bars,450);
  const partial=updates.find(update=>update.processed_bars===250);assert.ok(partial);assert.equal(partial.total_bars,450);assert.equal(partial.progress,250/450);
  assert.ok(updates.slice(0,-1).every(update=>update.progress<1));assert.equal(updates.at(-1).progress,1);assert.equal(updates.at(-1).completed_intervals,1);
  assert.ok(updates.every(update=>update.total_intervals===1&&Number.isInteger(update.processed_bars)&&Number.isInteger(update.total_bars)));
});

test('candidate progress weights intervals equally and resets only their bar counters across scopes',()=>{
  const updates=[],datasets=[data(),data('day')];
  evaluateOptimizationTask(progressContext(datasets),progressTask,{onProgress:update=>updates.push(update),runBacktest:(dataset,cfg,hooks)=>{
    const total=Object.values(dataset.symbols).reduce((sum,rows)=>sum+rows.length,0);
    hooks.onProgress({processed_bars:Math.floor(total/2),total_bars:total});hooks.onProgress({processed_bars:total,total_bars:total});return report();
  }});
  assert.equal(updates[0].progress,0);assert.equal(updates[0].total_bars,15);assert.equal(updates.at(-1).progress,1);
  const daily=updates.filter(update=>update.interval==='day');assert.equal(daily[0].progress,.5);assert.equal(daily[0].processed_bars,0);assert.equal(daily[0].total_bars,60);assert.equal(daily[0].completed_intervals,1);
  assert.equal(daily.find(update=>update.processed_bars===30).progress,.75);assert.equal(daily.at(-1).completed_intervals,2);
  assert.ok(updates.every((update,index)=>!index||update.progress>=updates[index-1].progress));
  assert.ok(updates.slice(0,-1).every(update=>update.progress<1));
});

test('regressing or malformed source counters cannot invent or reverse candidate progress',()=>{
  const updates=[];
  evaluateOptimizationTask(progressContext([data()]),progressTask,{onProgress:update=>updates.push(update),runBacktest:(dataset,cfg,hooks)=>{
    hooks.onProgress({processed_bars:8,total_bars:15});hooks.onProgress({processed_bars:4,total_bars:15});
    hooks.onProgress({processed_bars:14,total_bars:99});hooks.onProgress({processed_bars:Infinity,total_bars:15});hooks.onProgress({processed_bars:16,total_bars:15});
    return report();
  }});
  assert.deepEqual(updates.map(update=>update.processed_bars),[0,8,8,15]);
  assert.ok(updates.every((update,index)=>!index||update.progress>=updates[index-1].progress));
});

test('a task that fails after its last bar cannot emit successful completion progress',()=>{
  const updates=[];
  assert.throws(()=>evaluateOptimizationTask(progressContext([data(),data('day')]),progressTask,{onProgress:update=>updates.push(update),runBacktest:(dataset,cfg,hooks)=>{
    const total=Object.values(dataset.symbols).reduce((sum,rows)=>sum+rows.length,0);hooks.onProgress({processed_bars:total,total_bars:total});
    if(dataset.interval==='day')throw fixtureCandidateError();return report();
  }}),error=>error.interval==='day');
  assert.equal(updates.at(-1).interval,'day');assert.equal(updates.at(-1).completed_intervals,1);assert.ok(updates.every(update=>update.progress<1));
});

test('cancellation after the final bar still prevents a success progress update',()=>{
  let cancelled=false;const updates=[];
  assert.throws(()=>evaluateOptimizationTask(progressContext([data()]),progressTask,{cancelled:()=>cancelled,onProgress:update=>{updates.push(update);if(update.processed_bars&&update.processed_bars===update.total_bars)cancelled=true;},runBacktest:(dataset,cfg,hooks)=>{
    const total=Object.values(dataset.symbols).reduce((sum,rows)=>sum+rows.length,0);hooks.onProgress({processed_bars:total,total_bars:total});return report();
  }}),error=>error.name==='AbortError');
  assert.ok(updates.every(update=>update.progress<1));assert.equal(updates.at(-1).completed_intervals,0);
});

test('synchronous optimizer forwards candidate fractions into its phase progress without changing results',()=>{
  const updates=[],cfg={...options};
  const result=optimizeStrategies([data()],cfg,{onProgress:update=>updates.push(update),runBacktest:(dataset,settings,hooks)=>{
    const total=Object.values(dataset.symbols).reduce((sum,rows)=>sum+rows.length,0);hooks.onProgress({processed_bars:5,total_bars:total});return report(-1);
  }});
  assert.equal(result.status,'no_improvement');const first=updates.find(update=>update.parallelism.active_sets[0]?.processed_bars===5);
  assert.ok(first);assert.equal(first.parallelism.active_sets[0].progress,1/3);assert.ok(Math.abs(first.progress-.6/9)<1e-12);
  assert.ok(updates.every((update,index)=>!index||update.progress>=updates[index-1].progress));assert.equal(updates.at(-1).progress,.6);
  assert.ok(updates.filter(update=>update.parallelism.active_workers).every(update=>update.progress<.6));
});

test('parallel phase progress includes every active set fraction but leaves unsettled tasks below completion',async()=>{
  const updates=[];
  const result=await optimizeStrategiesParallel([data()],{...options,parallelism:3},{onProgress:update=>updates.push(update),poolFactory:context=>({
    async runBatch(tasks,{prepare,onComplete,onProgress}){
      const active=tasks.map((task,index)=>({parameter_set_id:task.trial.parameter_set_id,phase:task.phase,progress:[.25,.75,0][index]}));let completed=0;
      const emit=()=>onProgress({worker_limit:3,active_workers:active.length,completed_tasks:completed,failed_tasks:0,total_tasks:tasks.length,active_sets:active.map(set=>({...set}))});
      emit();for(const set of active)set.progress=1;emit();
      for(const task of tasks){onComplete(task,evaluateOptimizationTask(context,prepare(task),{runBacktest:()=>report(-1)}));active.shift();completed++;emit();}
    },async close(){},
  })});
  assert.equal(result.status,'no_improvement');assert.ok(Math.abs(updates[0].progress-.2)<1e-12);
  assert.ok(updates.filter(update=>update.parallelism.active_workers).every(update=>update.progress<.6));
  assert.ok(updates.every((update,index)=>!index||update.progress>=updates[index-1].progress));assert.equal(updates.at(-1).progress,.6);
});

