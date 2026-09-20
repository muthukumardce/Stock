import {test,expect} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {ConfigManager} from '../src/config.js';
import {createApp} from '../src/main.js';

const PASSWORD='Browser-verification-only-123!';
let app,server,directory,origin;
test.beforeAll(async()=>{
  directory=mkdtempSync(join(tmpdir(),'stockpilot-browser-'));
  const manager=new ConfigManager(directory,{}),settings=await manager.load({password:PASSWORD});
  app=await createApp({settings,configManager:manager});server=app.listen(0,'127.0.0.1');await once(server,'listening');
  origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async()=>{
  server?.close();await app?.shutdown();server?.closeAllConnections();
  if(directory){expect(directory.startsWith(join(tmpdir(),'stockpilot-browser-'))).toBeTruthy();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});
async function signIn(page){
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin);await expect(page).toHaveURL(origin+'/login');
  await page.getByLabel('Username',{exact:true}).fill('admin');await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in'}).click();await expect(page.getByRole('heading',{name:'Trading workspace'})).toBeVisible();
  await expect(page.locator('#engine-status')).toHaveText('Disconnected');
}
test('real login, live state, settings defaults and logout work without broker credentials',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await signIn(page);
  await expect(page.locator('#mode-pill')).toHaveText('Paper trading');
  await page.screenshot({path:testInfo.outputPath('overview.png'),fullPage:true});
  await page.locator('nav [data-page="settings"]').click();
  await expect(page.locator('#config-intraday_short_enabled')).toBeChecked();
  await expect(page.locator('#config-event_risk_enabled')).toBeChecked();
  await expect(page.locator('#config-enable_opening_range')).toBeChecked();
  await expect(page.locator('#config-analytics_workers')).toHaveValue('0');
  await expect(page.locator('#config-research_cpu_affinity')).toHaveValue('pinned');await expect(page.locator('#config-research_cpu_affinity option')).toHaveText(['Pin workers to CPUs','Automatic scheduling']);
  await expect(page.locator('#config-fields')).not.toContainText('PAPER_CAPITAL');
  await expect(page.locator('#holding-policy')).toHaveValue('selected');
  await page.locator('#managed-symbols').fill('INFY');await page.locator('#holding-policy').selectOption('ignore');
  await expect(page.locator('#managed-symbols')).toBeDisabled();
  await page.locator('#settings-form [type="submit"]').click();
  await expect(page.locator('#toast')).toContainText('Settings saved');
  await page.reload();await page.locator('nav [data-page="settings"]').click();
  await expect(page.locator('#holding-policy')).toHaveValue('ignore');await expect(page.locator('#managed-symbols')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await page.locator('article').filter({has:page.getByRole('heading',{name:'Existing holdings',exact:true})}).screenshot({path:testInfo.outputPath('ignore-existing-holdings.png')});
  await page.locator('#holding-policy').selectOption('selected');await expect(page.locator('#managed-symbols')).toBeEnabled();
  await expect(page.locator('#managed-symbols')).toHaveValue('INFY');await page.locator('#managed-symbols').fill('');
  await page.locator('#settings-form [type="submit"]').click();await expect(page.locator('#toast')).toContainText('Settings saved');
  await page.locator('nav [data-page="research"]').click();await expect(page.locator('#research-status')).toHaveText('Ready');
  await expect(page.locator('#research-start')).toBeDisabled();
  await page.locator('nav [data-page="activity"]').click();await expect(page.locator('#activity-list')).toContainText('Administrator signed in');
  await page.locator('#logout').click();await expect(page).toHaveURL(/\/login/);expect(errors).toEqual([]);
});

test('activity errors link to settings and Clear All deletes saved history across filters without changing trading records',async({page},testInfo)=>{
  await signIn(page);
  const store=app.state.store,journal=store.get(app.state.engine.state_key),strategies=store.get('strategy_settings');
  for(let i=0;i<510;i++)store.event('test.activity',`Historical entry ${i}`);
  store.event('scan_summary','Scanner entry checks',{ 'decision:maximum_positions':120 });
  store.event('order_rejected','Cover entry rejected (PermissionException, HTTP 403).',{kind:'PermissionException',http_status:403,operation:'cover_entry'},'error');
  await page.reload();await page.locator('nav [data-page="activity"]').click();
  await expect(page.locator('#activity-list')).toContainText('Profile → IP Whitelist');
  await page.locator('#activity-list [data-help-target="config-max_positions"]').click();
  await expect(page.locator('#page-settings')).toBeVisible();await expect(page.locator('#config-max_positions')).toBeFocused();
  await page.locator('nav [data-page="activity"]').click();await page.locator('#event-level').selectOption('error');await page.locator('#event-search').fill('403');
  await expect(page.locator('#activity-list .audit-row')).toHaveCount(1);
  await expect(page.locator('#activity-list a', {hasText:'Kite Connect developer account'})).toHaveAttribute('href','https://developers.kite.trade/');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('activity-troubleshooting.png'),fullPage:true});
  const response=page.waitForResponse(r=>r.url().endsWith('/api/events')&&r.request().method()==='DELETE');
  await page.getByRole('button',{name:'Clear All',exact:true}).click();expect((await response).ok()).toBeTruthy();
  await expect(page.locator('#activity-list .audit-row')).toHaveCount(0);
  expect(store.latest_events()).toEqual([]);expect(store.get(app.state.engine.state_key)).toEqual(journal);expect(store.get('strategy_settings')).toEqual(strategies);
  expect(await (await page.request.get(origin+'/api/events/export')).text()).toBe('');
  const id=store.event('paper_fill','New simulated fill after Clear All');expect(id).toBeGreaterThan(store.event_floor());
  await page.locator('#event-level').selectOption('');await page.locator('#event-search').fill('');await page.evaluate(()=>refresh());
  await expect(page.locator('#activity-list')).toContainText('New simulated fill after Clear All');
  await expect(page.locator('#activity-list')).not.toContainText('Historical entry');
});
test('read-only account fixtures render short exposure and hold within a mobile viewport',async({page},testInfo)=>{
  const engine=app.state.engine;engine.capital=100000;
  engine.positions={INFY:{symbol:'INFY',token:1,strategy:'intraday',setup:'opening_range',side:'SELL',quantity:10,entry:1500,last:1495,stop:1510,target:1480,entry_fee:15,protection:'simulated',opened_at:new Date().toISOString()}};
  app.state.store.event('test.fixture','Read-only short-position fixture; no broker connected.',{symbol:'INFY'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  await expect(page.locator('#positions-body')).toContainText('INFY');
  await expect(page.locator('#positions-body')).toContainText(/SELL|Short/i);
  await expect(page.locator('#positions-body')).toContainText('35.00');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('short-position.png'),fullPage:true});expect(errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('short-position-viewport.png')});
  engine.positions={};
});

test('startup progress and background jobs stay visible, truthful and usable on desktop and mobile',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  let fixture={connected:true,configured:true,status:'paused',mode:'paper',maintenance:false,account_fresh:true,signals:[],startup:{status:'idle'},strategy_settings:{intraday_enabled:true,intraday_allocation_pct:1,swing_allocation_pct:0}};
  await page.evaluate(next=>{liveView.stop();render(next);},fixture);
  await page.route('**/api/state**',route=>route.fulfill({json:{state:fixture,events:[]}}));
  let releaseStart;
  await page.route('**/api/trading/start',async route=>{await new Promise(resolve=>{releaseStart=resolve;});await route.fulfill({status:202,json:{accepted:true,startup:fixture.startup}});});
  await page.locator('#start').click();
  await expect(page.locator('#startup-card')).toBeVisible();await expect(page.locator('#startup-phase')).toHaveText('Sending start request');
  await expect(page.locator('#startup-progress')).toBeHidden();await expect(page.locator('#start')).toBeDisabled();await expect(page.locator('#pause')).toBeEnabled();
  fixture={...fixture,status:'running',startup:{status:'running',phase:'universe',message:'Verifying the NSE stock and ETF directory.',completed:2,total:6,revision:2,operation_id:'browser-fixture',started_at:'2026-09-17T10:00:00+05:30',updated_at:'2026-09-17T10:00:02+05:30'},broker_clock:{status:'skewed',blocked:true,offset_lower_ms:220000,offset_upper_ms:224000}};
  await page.evaluate(next=>render(next),fixture);releaseStart();
  await expect(page.locator('#startup-count')).toHaveText('2 of 6 steps · 33%');await expect(page.locator('#engine-status')).toHaveText('Clock synchronization required');
  await page.locator('#startup-card').screenshot({path:testInfo.outputPath('startup-progress.png')});
  fixture={...fixture,broker_clock:{status:'aligned',blocked:false},resources:{cpu_percent:18.4},performance:{live_workers:2,worker_limit:8,active_jobs:1,active_batch_count:1,queue_depth:15,completed_symbols:128,active_batches:[{symbols:['INFY','HDFCBANK'],symbol_count:2,strategies:['intraday'],started_at:'2026-09-17T10:00:02+05:30'}]},background:{tasks:[
    {id:'account',label:'Account reconciliation',status:'waiting',message:'Next account refresh is scheduled.',updated_at:'2026-09-17T10:00:02+05:30'},
    {id:'daily_history',label:'Daily history',status:'running',message:'Downloading completed daily candles.',current_item:'INFY',completed:5,total:20,failed:1,updated_at:'2026-09-17T10:00:02+05:30'},
    {id:'intraday_history',label:'Intraday history',status:'waiting',message:'Waiting before retrying unavailable history.',current_item:'HDFCBANK',completed:7,total:20,ready:5,progress_kind:'session_warmup',next_retry_at:'2026-09-17T10:01:00+05:30'},
  ],research:{status:'running',progress:42,message:'Comparing strategies on completed historical candles.'}}};
  await page.evaluate(next=>render(next),fixture);await page.locator('nav [data-page="background"]').click();
  await expect(page.getByRole('heading',{name:'Background work',exact:true})).toBeVisible();await expect(page.locator('#startup-card')).toBeVisible();
  await expect(page.locator('#background-tasks')).toContainText('5 of 20 completed · 25%');await expect(page.locator('#background-tasks')).toContainText('Current: INFY');
  await expect(page.locator('#background-tasks')).toContainText('7 of 20 warmed up this session');
  await expect(page.locator('#background-tasks')).toContainText('5 currently loaded; 15 awaiting load or refresh');
  await expect(page.locator('#background-batches')).toContainText('INFY, HDFCBANK');await expect(page.locator('#background-queue')).toHaveText('15 queued analyses');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('background-work.png'),fullPage:true});
  fixture={...fixture,waiting_for_funds:true,startup:{...fixture.startup,status:'complete',phase:'complete',completed:6,revision:3,updated_at:'2026-09-17T10:00:03+05:30'}};
  await page.evaluate(next=>render(next),fixture);await expect(page.locator('#startup-title')).toHaveText('Startup checks finished');
  await page.locator('nav [data-page="overview"]').click();await expect(page.locator('#engine-status')).toHaveText('Waiting for funds');
  fixture={...fixture,status:'paused',connected:false,waiting_for_funds:false,startup:{...fixture.startup,status:'running',phase:'account',completed:1,revision:4}};
  await page.evaluate(next=>render(next),fixture);
  await page.route('**/api/trading/pause',route=>{
    fixture={...fixture,startup:{...fixture.startup,status:'cancelled',phase:'cancelled',message:'Startup cancelled before trading was armed.',revision:5}};
    return route.fulfill({status:202,json:{accepted:true,startup:fixture.startup}});
  });
  await page.locator('#pause').click();await expect(page.locator('#startup-title')).toHaveText('Startup cancelled');
  await expect(page.locator('#engine-status')).toHaveText('Entries paused');await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#startup-card').screenshot({path:testInfo.outputPath('startup-cancelled.png')});
  expect(errors).toEqual([]);
});

test('research failure causes and broker cooldowns are actionable without repeated requests',async({page},testInfo)=>{
  const errors=[],mutations=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  const now='2026-09-17T10:00:00+05:30',until='2026-09-17T10:02:00+05:30',failure={code:'rate_limit',message:'Zerodha limited historical requests. The program will wait before retrying.',http_status:429,phase:'symbol_history',symbol:'INFY',retryable:true,next_retry_at:until};
  let research={status:'failed',progress:12,error:failure,issues:[failure],cooldown:{next_retry_at:until},automation:{enabled:true,status:'retry_wait',reason:'Automatic history retry is scheduled.',next_retry_at:until}};
  let fixture={connected:true,configured:true,status:'paused',mode:'paper',maintenance:false,account_fresh:true,server_time:now,signals:[],api_limits:{status:'cooldown',categories:[{category:'historical',status:'cooldown',retry_at:until,retry_after_seconds:120,rate_limited_responses:2,blocked_requests:8}]},background:{research}};
  await page.evaluate(next=>{liveView.stop();render(next);},fixture);
  await page.route('**/api/research',route=>route.fulfill({json:research}));
  await page.route('**/api/research/start',route=>{mutations.push(route.request().method());return route.fulfill({status:429,json:{detail:'Wait for the scheduled retry.'}});});
  await page.locator('nav [data-page="research"]').click();
  await expect(page.locator('#research-status')).toHaveText('Waiting for retry');await expect(page.locator('#research-start')).toBeDisabled();
  await expect(page.locator('#research-failure-title')).toHaveText('Zerodha request limit reached');await expect(page.locator('#research-failure-details')).toContainText('429');
  await expect(page.locator('#research-failure-details')).toContainText('INFY');await expect(page.locator('#research-retry')).toContainText('10:02:00 IST');
  await page.locator('#research-issues-title').click();await expect(page.locator('#research-issues-list')).toContainText('HTTP 429');
  await page.locator('#research-refresh').click();await page.evaluate(()=>researchAction('start'));expect(mutations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('research-rate-limit.png'),fullPage:true});
  await page.locator('nav [data-page="background"]').click();await expect(page.locator('#background-api')).toContainText('120 seconds remaining');
  await expect(page.locator('#background-research-error')).toContainText('HTTP 429');
  await page.screenshot({path:testInfo.outputPath('background-rate-limit.png'),fullPage:true});
  research={status:'failed',progress:72,error:{code:'worker_timeout',message:'Historical simulation exceeded its calculation time limit.',http_status:null,phase:'worker_enhanced',symbol:null,retryable:false,next_retry_at:null,runtime_budget_ms:1800000,processed_bars:12345,total_bars:200000,timeout_kind:'variant'},issues:[],automation:{enabled:true,status:'action_required',reason:'Automatic retry is paused after the simulation time limit.'}};
  fixture={...fixture,api_limits:{status:'ready',categories:[]},background:{research}};await page.evaluate(next=>render(next),fixture);
  await page.locator('nav [data-page="research"]').click();await expect(page.locator('#research-failure-title')).toHaveText('Historical simulation timed out');
  await expect(page.locator('#research-failure-details')).not.toContainText('429');await expect(page.locator('#research-start')).toBeEnabled();
  await expect(page.locator('#research-failure-details')).toContainText('30 minutes (1,800 seconds)');await expect(page.locator('#research-failure-details')).toContainText('12,345 / 2,00,000');await expect(page.locator('#research-failure-details')).toContainText('Single comparison pass');
  await expect(page.locator('#research-retry')).toContainText('Automatic retry is paused');
  await page.screenshot({path:testInfo.outputPath('research-worker-timeout.png'),fullPage:true});
  expect(errors).toEqual([]);expect(mutations).toEqual([]);
});

test('tuning progress, historical rejection and applied live thresholds remain distinct',async({page},testInfo)=>{
  const errors=[],mutations=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  const fixture={connected:true,configured:true,status:'paused',mode:'live',maintenance:false,account_fresh:true,signals:[]};
  await page.evaluate(next=>{liveView.stop();render(next);},fixture);
  let research={status:'running',progress:82,tuning:{phase:'tuning_validation',trial:3,trial_count:9,progress:0.375,message:'Checking the current candidate on separate validation dates.'}};
  await page.route('**/api/research',route=>route.fulfill({json:research}));
  await page.route('**/api/research/start',route=>{mutations.push(route.request().method());return route.fulfill({status:400,json:{detail:'Unexpected mutation'}});});
  await page.locator('nav [data-page="research"]').click();await expect(page.locator('#tuning-phase')).toHaveText('Evaluation 3 of 9 · Validating candidates');
  await expect(page.locator('#research-progress')).toHaveJSProperty('value',82);await expect(page.locator('#tuning-progress')).toHaveCount(0);await expect(page.locator('#research-start')).toBeDisabled();await expect(page.locator('#tuning-result')).toBeHidden();
  await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('tuning-progress.png')});
  const metrics={net_return_pct:1.25,max_drawdown_pct:0.8,trade_count:21},stage={metrics,data_quality:{eligible:true}},parameters={min_signal_score:65,min_adx:22,min_setup_volume:1.4,max_atr_extension:1.8};
  let optimization={status:'no_improvement',reason:'The finalist failed the untouched final test. No runner-up is promoted.',parameters:null,incumbent_parameters:{...parameters,min_signal_score:60},selected_id:'candidate-1',holdout_consumed:true,limits:{max_candidates:9,max_runtime_ms:600000},elapsed_ms:45000,ranges:{'5minute':{train:{from:'2026-07-01',to:'2026-08-10'},validation:{from:'2026-08-11',to:'2026-08-25'},test:{from:'2026-08-26',to:'2026-09-16'}}},application:{status:'not_applied',reason:'No candidate met all acceptance checks.'},trials:[{id:'incumbent',parameters:{},train:{'5minute':stage},validation:{'5minute':stage},test:{'5minute':stage},status:'incumbent',reason:'Current settings reference.'},{id:'candidate-1',parameters,train:{'5minute':stage},validation:{'5minute':stage},test:{'5minute':{...stage,metrics:{...metrics,net_return_pct:-0.5}}},status:'test_failed',reason:'Final-test return failed the requirement.'}]};
  research={status:'complete',progress:100,report:{optimization}};await page.locator('#research-refresh').click();
  await expect(page.locator('#tuning-verdict')).toHaveText('No validated improvement');await expect(page.locator('#tuning-application')).toHaveText('Settings not applied');await expect(page.locator('#tuning-parameters-panel')).toBeHidden();
  await page.locator('#tuning-trials-title').click();await expect(page.locator('#tuning-trials')).toContainText('-0.5% net');await expect(page.locator('#tuning-limits')).toContainText('overlapping dates cannot be reused');
  await expect(page.locator('#tuning-ranges')).toContainText('Intraday · Final-test dates');await page.locator('#tuning-trials details').first().locator('summary').click();await expect(page.locator('#tuning-trials details').first()).toContainText('60');
  await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('tuning-no-improvement.png')});
  optimization={...optimization,status:'accepted',reason:'The finalist passed the required checks.',parameters:{min_signal_score:65},trials:optimization.trials.map(trial=>trial.id==='incumbent'?trial:{...trial,parameters:{min_signal_score:65},status:'accepted',reason:'Final-test requirements passed.',train:{'5minute':{...stage,metrics:{...metrics,net_return_pct:2.1}}},validation:{'5minute':{...stage,metrics:{...metrics,net_return_pct:1.75}}},test:{'5minute':{...stage,metrics:{...metrics,net_return_pct:1.55}}}}),application:{status:'waiting',reason:'Waiting for flat managed exposure and no active orders.',changes:[]}};
  research={status:'complete',progress:100,report:{optimization}};await page.locator('#research-refresh').click();
  await expect(page.locator('#tuning-verdict')).toHaveText('Passed historical checks');await expect(page.locator('#tuning-application')).toHaveText('Waiting to apply settings');
  await expect(page.locator('#research-cancel')).toBeEnabled();await expect(page.locator('#research-cancel')).toHaveText('Cancel queued change');
  optimization={...optimization,application:{status:'applied',reason:'Validated thresholds applied in the existing live mode.',applied_at:'2026-09-17T10:15:00+05:30',changes:[{key:'min_signal_score',before:60,after:65}]} };
  research={status:'complete',progress:100,report:{optimization}};await page.locator('#research-refresh').click();
  await expect(page.locator('#tuning-application')).toHaveText('Settings applied');await expect(page.locator('#tuning-parameters')).toContainText('65');await expect(page.locator('#engine-status')).toHaveText('Entries paused');
  expect(await page.evaluate(()=>({mode:state.mode,status:state.status,overflow:document.documentElement.scrollWidth>window.innerWidth+1}))).toEqual({mode:'live',status:'paused',overflow:false});
  await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('tuning-applied.png')});expect(mutations).toEqual([]);
  research={status:'complete',progress:100,report:{optimization:{...optimization,application:{status:'waiting',reason:'Waiting for managed exposure to clear.'}}}};await page.locator('#research-refresh').click();
  await page.route('**/api/research/cancel',route=>{mutations.push('cancel');research={...research,status:'cancelled',report:{optimization:{...optimization,application:{status:'not_applied',reason:'The queued parameter change was cancelled.'}}}};return route.fulfill({json:research});});
  await page.locator('#research-cancel').click();await expect(page.locator('#tuning-application')).toHaveText('Settings not applied');await expect(page.locator('#tuning-application-reason')).toContainText('cancelled');await expect(page.locator('#research-cancel')).toBeDisabled();
  expect(errors).toEqual([]);expect(mutations).toEqual(['cancel']);expect(await page.evaluate(()=>state.status)).toBe('paused');
});

test('overall Research progress and active candidate bars advance, settle, reappear by phase and clear on cancellation',async({page},testInfo)=>{
  const errors=[],writes=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);await page.evaluate(()=>{liveView.stop();render({connected:true,configured:true,status:'paused',mode:'paper',signals:[]});});
  const activeSets=Array.from({length:50},(_,index)=>({parameter_set_id:`P${index+1}`,phase:'tuning_train',interval:'5minute',...(index<49?{progress:(index+1)/100,processed_bars:(index+1)*100,total_bars:10000,completed_intervals:0,total_intervals:2}:{})}));
  const trials=[{id:'incumbent',parameter_set_id:'P1',status:'training',reason:'Evaluation is running.'}];
  let research={status:'collecting',progress:4,message:'Historical research is in progress.',current_task:{title:'Downloading INFY candles',detail:'Five-minute history · 4 of 20 stocks'}};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();
  await expect(page.locator('#research-current-task')).toHaveText('Downloading INFY candles');await expect(page.locator('#research-message')).toHaveText('Five-minute history · 4 of 20 stocks');
  for(const [title,detail] of [['Preparing benchmark context','NIFTY 50 · daily candles'],['Comparing baseline rules','Intraday · baseline pass'],['Comparing enhanced rules','Intraday · enhanced pass']]){research={status:'running',progress:25,current_task:{title,detail}};await page.locator('#research-refresh').click();await expect(page.locator('#research-current-task')).toHaveText(title);await expect(page.locator('#research-message')).toHaveText(detail);}
  research={status:'running',progress:46,current_task:{title:'Training parameter sets',detail:'Evaluating 50 parameter sets on training dates.'},tuning:{phase:'tuning_train',message:'Training parameter sets.',trials,parallelism:{worker_limit:50,active_workers:50,completed_tasks:0,total_tasks:50,active_sets:activeSets}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#research-current-task')).toHaveText('Training parameter sets');
  await expect(page.locator('#page-research progress')).toHaveCount(51);await expect(page.locator('#research-progress')).toHaveJSProperty('value',46);await expect(page.getByRole('progressbar',{name:'P1 · Training progress',exact:true})).toHaveJSProperty('value',1);await expect(page.getByRole('progressbar',{name:'P50 · Training progress',exact:true})).not.toHaveAttribute('value');
  await expect(page.locator('#tuning-active-sets')).toContainText('100 of 10,000 bars · 0 of 2 intervals complete');expect(await page.locator('#tuning-active-sets').evaluate(element=>element.scrollHeight>element.clientHeight&&element.clientHeight<=420)).toBe(true);
  await page.locator('#page-research').screenshot({path:testInfo.outputPath('research-overall-and-candidates.png')});
  research={...research,progress:54,tuning:{...research.tuning,parallelism:{...research.tuning.parallelism,active_workers:2,completed_tasks:48,active_sets:[{...activeSets[0],progress:0.65,processed_bars:6500},activeSets[49]]}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#research-progress')).toHaveJSProperty('value',54);await expect(page.getByRole('progressbar',{name:'P1 · Training progress',exact:true})).toHaveJSProperty('value',65);await expect(page.locator('#tuning-active-sets progress')).toHaveCount(2);
  await page.locator('#tuning-parallel').screenshot({path:testInfo.outputPath('candidate-progress-advanced.png')});
  research={...research,progress:64,tuning:{...research.tuning,trials:[{...trials[0],status:'error',error:{phase:'train',message:'Worker stopped.'}}],parallelism:{...research.tuning.parallelism,active_workers:1,completed_tasks:49,failed_tasks:1,active_sets:[activeSets[49]]}}};await page.locator('#research-refresh').click();
  await expect(page.getByRole('progressbar',{name:'P1 · Training progress',exact:true})).toHaveCount(0);await expect(page.locator('#tuning-active-sets progress')).toHaveCount(1);await expect(page.locator('#tuning-live-sets')).toContainText('Worker stopped.');await expect(page.locator('#research-progress')).toHaveJSProperty('value',64);
  research={...research,progress:76,tuning:{...research.tuning,parallelism:{...research.tuning.parallelism,active_workers:0,completed_tasks:50,active_sets:[]}}};await page.locator('#research-refresh').click();await expect(page.locator('#page-research progress')).toHaveCount(1);
  research={...research,progress:82,current_task:{title:'Validating parameter sets',detail:'P50 is checking separate validation dates.'},tuning:{...research.tuning,phase:'tuning_validation',parallelism:{...research.tuning.parallelism,active_workers:1,active_sets:[{...activeSets[49],phase:'tuning_validation',progress:0.3}]}}};await page.locator('#research-refresh').click();await expect(page.getByRole('progressbar',{name:'P50 · Validation progress',exact:true})).toHaveJSProperty('value',30);await expect(page.locator('#research-current-task')).toHaveText('Validating parameter sets');
  await page.route('**/api/research/cancel',route=>{writes.push(route.request().url());research={...research,status:'cancelled'};return route.fulfill({json:research});});await page.locator('#research-cancel').click();
  await expect(page.locator('#tuning-active-sets progress')).toHaveCount(0);await expect(page.locator('#research-progress')).toHaveJSProperty('value',82);await expect(page.locator('#research-status')).toHaveText('Cancelled');await expect(page.locator('#research-current-task')).toHaveText('Research cancelled');expect(writes).toHaveLength(1);expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)).toBe(false);
});

test('P sets expose multicore progress and candidate errors while applying a healthy saved set without starting trading',async({page},testInfo)=>{
  const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  await page.evaluate(()=>{liveView.stop();render({connected:true,configured:true,status:'paused',mode:'live',maintenance:false,account_fresh:true,signals:[]});});
  const current={min_signal_score:60,min_adx:20,min_setup_volume:1.5,max_atr_extension:2},stage={metrics:{net_return_pct:-0.75,max_drawdown_pct:1.2,trade_count:12},data_quality:{eligible:false,reason:'Net return did not pass the automatic gate.'}};
  const trials=[{id:'incumbent',parameter_set_id:'P1',parameters:{},effective_parameters:current,status:'incumbent',train:{'5minute':stage},reason:'Starting parameters.',application_eligible:true,application_reason:'Completed set can be selected manually.'},{id:'candidate_1',parameter_set_id:'P2',parameters:{min_signal_score:55},effective_parameters:{...current,min_signal_score:55},status:'rejected',train:{'5minute':stage},reason:'Training net performance was not positive.',application_eligible:true,application_reason:'Manual selection is available despite the failed profitability check.'},{id:'candidate_2',parameter_set_id:'P3',parameters:{min_adx:23},effective_parameters:{...current,min_adx:23},status:'pending',reason:'Still being evaluated.',application_eligible:false,application_reason:'Training must finish before this set can be selected.'}];
  let research={status:'running',progress:20,tuning:{phase:'tuning_train',progress:0.2,message:'train: candidate_1 and candidate_2',trials,parallelism:{worker_limit:4,active_workers:2,completed_tasks:1,total_tasks:3,active_sets:[{parameter_set_id:'P2',phase:'tuning_train',interval:'5minute'},{parameter_set_id:'P3',phase:'tuning_train',interval:'5minute'}]}}};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();
  await expect(page.locator('#tuning-worker-counts')).toHaveText('2 active workers · 4 worker capacity · 1 of 3 tasks completed');await expect(page.locator('#tuning-active-sets')).toContainText('P3');await expect(page.locator('#tuning-message')).toHaveText('train: P2 and P3');
  await expect(page.locator('#tuning-live-sets')).toContainText('Maximum ATR extension');await expect(page.locator('#tuning-live-sets button')).toHaveCount(0);await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('parameter-sets-live.png')});
  if(testInfo.project.name==='mobile'){await page.locator('#tuning-live-sets').evaluate(element=>element.scrollLeft=element.scrollWidth);expect(await page.locator('#tuning-live-sets').evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('parameter-sets-live-scrolled.png')});}
  trials[2]={...trials[2],status:'error',train:{'5minute':stage},error:{code:'worker_error',message:'Worker <memory> limit.',phase:'validation',interval:'5minute'},reason:'The validation calculation failed.',application_reason:'A calculation error prevents selecting this set.'};
  research={...research,tuning:{...research.tuning,parallelism:{...research.tuning.parallelism,active_workers:1,completed_tasks:2,failed_tasks:1,active_sets:[{parameter_set_id:'P2',phase:'tuning_validation',interval:'5minute'}]}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#tuning-worker-counts')).toHaveText('1 active workers · 4 worker capacity · 2 of 3 tasks completed (1 failed)');
  const liveError=page.locator('#tuning-live-sets tbody tr').filter({has:page.getByRole('rowheader',{name:'P3',exact:true})});await expect(liveError.locator('.badge.red')).toHaveText('Error');await expect(liveError).toContainText('Phase: Validation · Intraday 5-minute · worker error: Worker <memory> limit.');await expect(liveError.locator('memory')).toHaveCount(0);await expect(liveError).toContainText('-0.75% net');
  await page.locator('#tuning-live-sets').evaluate(element=>element.scrollLeft=element.scrollWidth);await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('candidate-errors-live.png')});
  const optimization={report_id:'report-browser-sets',status:'completed_with_errors',failed_trials:1,reason:'A candidate calculation error prevented complete evaluation; completed evidence is retained.',parameters:null,incumbent_parameters:current,trials,application:{status:'not_applied',source:'automatic',reason:'No automatic winner.'}};
  const coverage={dataset:{interval:'5minute',symbols:['INFY','HDFCBANK','UNKNOWN']},metadata:{diversification:{policy:'industry_round_robin_v1',status:'limited',requested_count:20,selected_count:20,members:[{symbol:'INFY',industry:'Information technology',classification_status:'fresh'},{symbol:'HDFCBANK',industry:'Banking',classification_status:'fresh'},{symbol:'NO_HISTORY',industry:'Automobiles',classification_status:'fresh'},{symbol:'UNKNOWN',industry:null,classification_status:'unknown'}],caveat:'Industry spread cannot prevent common market losses. Missing history reduced this report.'}}};
  research={status:'complete',progress:100,report:{...coverage,optimization}};await page.locator('#research-refresh').click();
  await expect(page.locator('#research-status')).toHaveText('Complete');await expect(page.locator('#tuning-verdict')).toHaveText('Completed with candidate errors');await expect(page.locator('#tuning-report-note')).toContainText('1 candidate calculation error');
  await expect(page.locator('#research-diversification-summary')).toHaveText('20 requested · 20 selected · 3 instruments in this report across 2 classified industries');await expect(page.locator('#research-industries')).toContainText('Banking');await expect(page.locator('#research-industries')).not.toContainText('Automobiles');await expect(page.locator('#research-unclassified')).toContainText('UNKNOWN');await page.locator('#research-diversification').screenshot({path:testInfo.outputPath('industry-coverage.png')});
  await expect(page.getByRole('button',{name:'Apply P2',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Apply P3',exact:true})).toBeDisabled();await expect(page.locator('#tuning-sets')).toContainText('Training net performance was not positive.');
  let release;await page.route('**/api/research/apply',async route=>{requests.push(route.request().postDataJSON());await new Promise(resolve=>release=resolve);research={...research,report:{optimization:{...optimization,application:{status:'waiting',source:'manual',parameter_set_id:'P2',report_id:optimization.report_id,reason:'P2 is queued until managed exposure is flat.',changes:[]}}}};await route.fulfill({json:research});});
  await page.getByRole('button',{name:'Apply P2',exact:true}).click();await expect.poll(()=>requests.length).toBe(1);await page.evaluate(()=>applyResearchSet('report-browser-sets','P2'));expect(requests).toEqual([{report_id:'report-browser-sets',parameter_set_id:'P2'}]);release();
  await expect(page.locator('#tuning-application-origin')).toHaveText('P2 · Manual selection');await expect(page.locator('#tuning-application')).toHaveText('Waiting to apply settings');await expect(page.locator('#research-cancel')).toHaveText('Cancel queued change');await expect(page.locator('#research-cancel')).toBeEnabled();
  await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('parameter-sets-manual.png')});
  if(testInfo.project.name==='mobile'){await page.locator('#tuning-sets').evaluate(element=>element.scrollLeft=0);await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('parameter-sets-manual-left.png')});}
  research={...research,report:{optimization:{...optimization,application:{status:'applied',source:'manual',parameter_set_id:'P2',report_id:optimization.report_id,reason:'Full P2 thresholds applied.',applied_at:'2026-09-17T11:00:00+05:30',changes:[{key:'min_signal_score',before:60,after:55}]}}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#tuning-application')).toHaveText('Settings applied');await expect(page.locator('#tuning-parameters')).toContainText('1.5');await expect(page.locator('#tuning-verdict')).toHaveText('Completed with candidate errors');
  expect(await page.evaluate(()=>({mode:state.mode,status:state.status,overflow:document.documentElement.scrollWidth>window.innerWidth+1}))).toEqual({mode:'live',status:'paused',overflow:false});expect(errors).toEqual([]);expect(requests).toHaveLength(1);
});

test('comparison worker telemetry distinguishes per-candle stock analysis from parameter candidates',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);await page.evaluate(()=>{liveView.stop();render({connected:true,configured:true,status:'paused',mode:'paper',signals:[]});});
  const comparison={phase:'baseline',interval:'5minute',symbol_count:150,processed_bars:15000,total_bars:200000,capacity:{worker_limit:32},parallelism:{worker_limit:32,active_workers:12,batch_completed_symbols:70,batch_total_symbols:150,batch_timestamp:'2026-09-16T10:15:00+05:30'}};
  let research={status:'running',progress:24,started_at:'2026-09-17T10:00:00+05:30',current_task:{title:'Comparing baseline rules',detail:'Intraday comparison · using 12 workers with capacity for 32.'},comparison};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();
  await expect(page.locator('#research-comparison-title')).toHaveText('Baseline comparison workers');await expect(page.locator('#research-comparison-details')).toContainText('12 active / 32 capacity');await expect(page.locator('#research-comparison-details')).toContainText('15,000 / 2,00,000');await expect(page.locator('#research-comparison-details')).not.toContainText('70 / 150');await expect(page.locator('#research-comparison-candle')).not.toHaveAttribute('open');await expect(page.locator('#page-research progress')).toHaveCount(1);await expect(page.locator('#tuning-active-sets progress')).toHaveCount(0);
  research={...research,progress:28,progress_detail:{stage:'Enhanced comparison',stage_progress:8.025,completed:16050,total:200000,unit:'candles'},current_task:{title:'Comparing enhanced rules',detail:'Intraday comparison · using 4 workers with capacity for 32.'},comparison:{...comparison,phase:'enhanced',processed_bars:16050,parallelism:{...comparison.parallelism,active_workers:4,batch_completed_symbols:10,batch_timestamp:'2026-09-16T10:20:00+05:30'}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#research-comparison-title')).toHaveText('Enhanced comparison workers');await expect(page.locator('#research-comparison-details')).toContainText('4 active / 32 capacity');await expect(page.locator('#research-comparison-details')).toContainText('16,050 / 2,00,000');await expect(page.locator('#research-progress-label')).toHaveText('Overall work: 28%');await expect(page.locator('#research-progress-detail')).toHaveText('Enhanced comparison: 8% · 16,050 / 2,00,000 candles');await page.locator('#research-comparison-candle summary').click();await expect(page.locator('#research-comparison-candle-details')).toContainText('10:20:00 IST');await expect(page.locator('#research-comparison-candle-details')).toContainText('10 / 150');await page.locator('.research-status-panel').screenshot({path:testInfo.outputPath('comparison-workers.png')});
  research={...research,progress:46,current_task:{title:'Training parameter sets',detail:'The comparison has finished.'},tuning:{phase:'tuning_train',parallelism:{active_sets:[{parameter_set_id:'P2',phase:'tuning_train',progress:0.4}]}}};await page.locator('#research-refresh').click();await expect(page.locator('#research-comparison')).toBeHidden();await expect(page.getByRole('progressbar',{name:'P2 · Training progress',exact:true})).toHaveJSProperty('value',40);
  research={...research,status:'cancelled'};await page.locator('#research-refresh').click();await expect(page.locator('#research-comparison')).toBeHidden();await expect(page.locator('#page-research progress')).toHaveCount(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)).toBe(false);expect(errors).toEqual([]);
});

test('final-test waiting retains parameter evidence and explains older empty reports',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);await page.evaluate(()=>{liveView.stop();render({connected:true,configured:true,status:'paused',mode:'paper',signals:[]});});
  let research={status:'complete',progress:100,report:{optimization:{status:'waiting_for_fresh_data',reason:'These final-test dates were already reserved.',trials:[],consumed_test_dates:{'5minute':'2026-09-16'},application:{status:'not_applied'}}}};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();await expect(page.locator('#tuning-set-selection')).toBeVisible();await expect(page.locator('#tuning-selection-note')).toContainText('No parameter results were saved for this run. Run analysis again');await expect(page.locator('#tuning-sets tbody tr')).toHaveCount(0);await expect(page.locator('#tuning-selection-help')).toBeHidden();
  const parameters={min_signal_score:60,min_adx:20,min_setup_volume:1.5,max_atr_extension:2},stage=net_return_pct=>({metrics:{net_return_pct,max_drawdown_pct:0.6,trade_count:12},data_quality:{eligible:true}}),trials=[{id:'incumbent',parameter_set_id:'P1',effective_parameters:parameters,status:'incumbent',train:{'5minute':stage(1)},validation:{'5minute':stage(0.3)},application_eligible:true},{id:'candidate_1',parameter_set_id:'P2',effective_parameters:{...parameters,min_signal_score:65},status:'final_test_pending',reason:'Validation passed; waiting for fresh final-test dates.',train:{'5minute':stage(2.2)},validation:{'5minute':stage(0.6)},application_eligible:true},{id:'candidate_2',parameter_set_id:'P3',effective_parameters:{...parameters,min_adx:23},status:'rejected',reason:'Training did not qualify.',train:{'5minute':stage(-1)},application_eligible:true}];
  const final_test_block={reason:'Final-test dates overlap a reserved window.',blocked_intervals:[{interval:'5minute',reserved_through:'2026-09-16',test_from:'2026-08-26',test_to:'2026-09-16'}]};
  research={status:'running',progress:75,tuning:{phase:'tuning_validation',trial:1,trial_count:3,final_test_allowed:false,final_test_block,trials,parallelism:{active_workers:2,worker_limit:3,completed_tasks:1,total_tasks:3,active_sets:[{parameter_set_id:'P2',phase:'tuning_validation',progress:0.999999,interval:'5minute',processed_bars:999,total_bars:1000,completed_intervals:0,total_intervals:1}]}},progress_detail:{scope:'overall',stage:'Validating parameter sets',stage_progress:62,completed:1,total:3,unit:'sets finished'}};await page.locator('#research-refresh').click();await expect(page.locator('#tuning-final-test-wait')).toBeVisible();await expect(page.locator('#tuning-phase')).toHaveText('Validating candidates · 1 of 3 sets finished in this phase');await expect(page.locator('#tuning-active-sets')).toContainText('Validation progress: 99.9%');await expect(page.locator('#tuning-active-sets')).toContainText('Current interval:');await expect(page.locator('#research-progress-detail')).toContainText('Percentage includes work on active sets');await expect(page.locator('#tuning-live-sets tbody tr')).toHaveCount(3);
  research={status:'complete',progress:100,report:{optimization:{report_id:'saved-waiting-report',status:'waiting_for_fresh_data',reason:'A finalist is waiting for a fresh final test.',final_test_allowed:false,final_test_block,incumbent_parameters:parameters,trials,application:{status:'not_applied',reason:'Automatic application requires a completed fresh final test.'}}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#tuning-final-test-wait')).toContainText('Training and validation can still produce parameter-set results');await expect(page.locator('#tuning-final-test-dates')).toContainText('Reserved through: 16 Sept 2026');await expect(page.locator('#tuning-final-test-dates')).toContainText('26 Aug 2026');await expect(page.locator('#tuning-sets tbody tr')).toHaveCount(3);await expect(page.locator('#tuning-sets')).toContainText('Waiting for final test');await expect(page.getByRole('button',{name:'Apply P2',exact:true})).toBeEnabled();await expect(page.locator('#tuning-application')).toHaveText('Settings not applied');await page.locator('#tuning-trials-title').click();await expect(page.locator('#tuning-trials')).toContainText('2.2% net');await expect(page.locator('#tuning-trials')).toContainText('0.6% net');await expect(page.locator('#tuning-trials')).toContainText('Not evaluated');await page.locator('#tuning-trials-title').click();await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('final-test-waiting-with-sets.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)).toBe(false);expect(errors).toEqual([]);
});

test('research CPU assignments show verified pins, fallback reasons and candidate worker mappings',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  const affinity={status:'pinned',verified:true,group:1,cpu:3,core:258},workers=[{worker_id:17,state:'busy',affinity},{worker_id:18,state:'starting',affinity:{status:'pinned',verified:false,group:0,cpu:4,core:2}},{worker_id:19,state:'retiring',affinity:{status:'failed',verified:false,reason:'Affinity <access denied>'}},{worker_id:16,state:'stopped',affinity:{status:'pinned',verified:true,group:0,cpu:1,core:0}}],capacity={worker_limit:3,affinity:{mode:'pinned',status:'planned',assignments:[{group:1,cpu:3,core:258}]}};
  let research={status:'running',progress:14,current_task:{title:'Comparing enhanced rules',detail:'Processing historical candles.'},comparison:{phase:'enhanced',interval:'5minute',symbol_count:150,processed_bars:12000,total_bars:200000,capacity,parallelism:{active_workers:1,worker_limit:3,workers}}};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();
  await expect(page.locator('#comparison-affinity-summary')).toContainText('1 of 2 current workers verified pinned');await expect(page.locator('#comparison-affinity-summary')).toContainText('2 retiring or stopped worker records');await page.locator('#comparison-affinity-details summary').click();await expect(page.locator('#comparison-affinity-workers')).toContainText('Group 1 · CPU 3');await expect(page.locator('#comparison-affinity-workers')).toContainText('Pin not verified');await expect(page.locator('#comparison-affinity-workers')).toContainText('Affinity <access denied>');await expect(page.locator('#comparison-affinity-workers')).toContainText('Previously verified pinned');await expect(page.locator('#comparison-affinity-workers access')).toHaveCount(0);await page.locator('#research-comparison').screenshot({path:testInfo.outputPath('comparison-cpu-affinity.png')});
  research={status:'running',progress:50,tuning:{phase:'tuning_train',capacity,parallelism:{active_workers:1,worker_limit:3,completed_tasks:1,total_tasks:3,workers,active_sets:[{parameter_set_id:'P2',phase:'tuning_train',progress:.35,worker_id:17,affinity,interval:'5minute',processed_bars:350,total_bars:1000}]}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#comparison-affinity')).toBeHidden();await expect(page.locator('#tuning-active-sets')).toContainText('Worker 17 · Verified pinned · Group 1 · CPU 3');await expect(page.getByRole('progressbar',{name:'P2 · Training progress',exact:true})).toHaveJSProperty('value',35);await page.locator('#tuning-affinity-details summary').click();await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('candidate-cpu-affinity.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)).toBe(false);
  const assignmentRegion=page.getByRole('region',{name:'Parameter worker CPU assignments',exact:true});await assignmentRegion.evaluate(element=>element.scrollLeft=element.scrollWidth);await assignmentRegion.screenshot({path:testInfo.outputPath('worker-cpu-assignments-scrolled.png')});if(testInfo.project.name==='mobile')expect(await assignmentRegion.evaluate(element=>element.scrollLeft>0)).toBe(true);
  research.tuning.capacity={affinity:{mode:'pinned',status:'unsupported',reason:'macOS does not support hard pinning.'}};research.tuning.parallelism={active_workers:1,worker_limit:1,workers:[{worker_id:20,affinity:{status:'unsupported',reason:'Using automatic scheduling'}}],active_sets:[]};await page.locator('#research-refresh').click();await expect(page.locator('#tuning-affinity-summary')).toContainText('Pinning is unsupported; using automatic scheduling');await expect(page.locator('#tuning-affinity-summary')).toContainText('0 of 1 reported workers verified pinned');await expect(page.locator('#tuning-active-sets li')).toHaveCount(0);
  research={status:'failed',error:{code:'cpu_affinity',phase:'worker_enhanced',message:'Select Automatic scheduling or inspect operating-system restrictions.'}};await page.locator('#research-refresh').click();await expect(page.locator('#research-failure-title')).toHaveText('Research CPU assignment failed');await expect(page.locator('#research-failure-message')).toContainText('Select Automatic scheduling');await expect(page.locator('#tuning-affinity')).toBeHidden();expect(errors).toEqual([]);
});

test('96 candidate progress bars retain their nodes, focus and scroll through live updates',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);await page.evaluate(()=>liveView.stop());
  const trials=Array.from({length:100},(_,index)=>({id:index?`candidate_${index}`:'incumbent',parameter_set_id:`P${index+1}`,effective_parameters:{min_signal_score:60,min_adx:20,min_setup_volume:1.5,max_atr_extension:2},status:'training'}));
  const workers=Array.from({length:384},(_,index)=>({process_id:4000+Math.floor(index/4),worker_id:index%4+1,state:'busy',affinity:{status:'pinned',verified:true,group:Math.floor(index/128),cpu:index%64,core:Math.floor(index/4)}}));
  let research={status:'running',progress:50,tuning:{phase:'tuning_train',trials,capacity:{process_limit:96},parallelism:{process_limit:96,active_processes:96,active_threads:384,thread_limit:384,workers,active_sets:trials.slice(0,96).map((trial,index)=>({parameter_set_id:trial.parameter_set_id,phase:'tuning_train',process_id:4000+index,thread_limit:4,active_threads:4,progress:0.1,processed_bars:100,total_bars:1000,interval:'day'}))}},report:{optimization:{status:'accepted',trials}}};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();await expect(page.locator('#tuning-active-sets progress')).toHaveCount(96);await expect(page.locator('#tuning-live-sets tbody tr')).toHaveCount(100);await expect(page.locator('#tuning-sets tbody tr')).toHaveCount(100);await expect(page.locator('#tuning-affinity-workers tr')).toHaveCount(384);
  const initial=await page.evaluate(()=>{
    const list=document.getElementById('tuning-active-sets'),live=document.getElementById('tuning-live-sets'),saved=document.getElementById('tuning-sets'),bar=list.children[47].querySelector('progress');
    list.scrollTop=5000;live.scrollTop=1800;saved.scrollTop=1600;bar.tabIndex=0;bar.focus({preventScroll:true});
    window.progressProbe={list,bar,row:list.children[47],live:live.querySelector('table'),saved:saved.querySelector('table'),worker:document.querySelector('#tuning-affinity-workers tr')};
    const before={list:list.scrollTop,live:live.scrollTop,saved:saved.scrollTop},observer=new MutationObserver(()=>{});observer.observe(list,{childList:true});
    for(let index=0;index<10;index++)updateView({state:{...state},events:[]});
    const changes=observer.takeRecords().length;observer.disconnect();
    return {before,after:{list:list.scrollTop,live:live.scrollTop,saved:saved.scrollTop},changes,retained:Object.values(window.progressProbe).every(node=>node.isConnected),focused:document.activeElement===bar};
  });
  expect(initial.after).toEqual(initial.before);expect(initial.changes).toBe(0);expect(initial.retained).toBe(true);expect(initial.focused).toBe(true);
  research.tuning.parallelism.active_sets[47]={...research.tuning.parallelism.active_sets[47],progress:0.375,processed_bars:375};await page.evaluate(()=>loadResearch());
  expect(await page.evaluate(()=>({retained:Object.values(window.progressProbe).every(node=>node.isConnected),value:window.progressProbe.bar.value,focused:document.activeElement===window.progressProbe.bar}))).toEqual({retained:true,value:37.5,focused:true});
  await page.locator('#tuning-parallel').screenshot({path:testInfo.outputPath('96-candidate-progress.png')});
  research.tuning.parallelism.active_sets.shift();research.tuning.parallelism.active_processes=95;research.tuning.trials=[{...trials[0],status:'error',error:{phase:'tuning_train',message:'Candidate calculation failed.'}},...trials.slice(1)];await page.evaluate(()=>loadResearch());
  await expect(page.locator('#tuning-active-sets progress')).toHaveCount(95);await expect(page.locator('#tuning-live-sets')).toContainText('Candidate calculation failed.');expect(await page.evaluate(()=>window.progressProbe.bar.isConnected&&document.activeElement===window.progressProbe.bar)).toBe(true);
  research.tuning.phase='tuning_validation';research.tuning.parallelism.active_sets=[{...research.tuning.parallelism.active_sets[46],phase:'tuning_validation',progress:0.1}];await page.evaluate(()=>loadResearch());
  await expect(page.getByRole('progressbar',{name:'P48 · Validation progress',exact:true})).toHaveAttribute('value','10');expect(await page.evaluate(()=>window.progressProbe.bar.isConnected)).toBe(false);
  research={...research,status:'cancelled'};await page.evaluate(()=>loadResearch());await expect(page.locator('#tuning-active-sets progress')).toHaveCount(0);expect(errors).toEqual([]);
});

test('candidate process IDs and analytics-thread capacity remain separate across phase updates',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  const workers=[{process_id:4201,worker_id:1,state:'busy',affinity:{status:'pinned',verified:true,group:0,cpu:3}},{process_id:4202,worker_id:1,state:'busy',affinity:{status:'pinned',verified:true,group:1,cpu:3}},{process_id:4202,worker_id:2,state:'ready',affinity:{status:'pinned',verified:true,group:1,cpu:4}}];
  let research={status:'running',progress:52,tuning:{phase:'tuning_train',capacity:{process_limit:96,threads_per_process:4,analytics_thread_limit:384,physical_cpus:96,cpu_target_percent:100,cpu_budget:192,allocated_cpu_threads:481,process_heap_mib:1024,analytics_worker_heap_mib:128,affinity:{mode:'pinned',status:'planned'}},parallelism:{active_processes:2,process_limit:96,active_threads:2,thread_limit:384,completed_tasks:1,total_tasks:100,workers,active_sets:[{parameter_set_id:'P2',process_id:4201,thread_limit:4,active_threads:1,phase:'tuning_train',progress:.25,interval:'5minute',processed_bars:250,total_bars:1000},{parameter_set_id:'P3',process_id:4202,thread_limit:4,active_threads:1,phase:'tuning_train',progress:.5,interval:'5minute',processed_bars:500,total_bars:1000}]}}};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();await expect(page.locator('#tuning-worker-counts')).toContainText('2 active candidate processes · 96 process capacity · 2 active analytics threads · 384 analytics thread capacity');await expect(page.locator('#tuning-active-sets')).toContainText('Process 4201 · 1 active / 4 capacity analytics threads');await expect(page.locator('#tuning-active-sets progress')).toHaveCount(2);await expect(page.locator('.tuning-worker-help')).toContainText('Its candle count covers that set');
  await page.locator('#tuning-affinity-details summary').click();await expect(page.locator('#tuning-affinity-workers')).toContainText('PID 4201 · Thread 1');await expect(page.locator('#tuning-affinity-workers')).toContainText('PID 4202 · Thread 1');await expect(page.locator('#tuning-affinity-workers tr')).toHaveCount(3);await page.locator('#tuning-resource-budget summary').click();await expect(page.locator('#tuning-resource-details')).toContainText('Physical cores available: 96');await expect(page.locator('#tuning-resource-details')).toContainText('192 logical CPUs (100% allocation target, not a utilization guarantee)');await expect(page.locator('#tuning-resource-details')).toContainText('481 planned coordinator and analytics threads share the eligible CPUs');await expect(page.locator('#tuning-resource-details')).toContainText('Up to 4 analytics threads per candidate process');await page.locator('#research-tuning').screenshot({path:testInfo.outputPath('candidate-process-thread-progress.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)).toBe(false);
  Object.assign(research.tuning.parallelism,{memory_waiting:true,memory_wait_reason:'free_memory',available_memory_mib:4096,memory_reserve_mib:8192,initializing_processes:1,max_initializing:4});await page.locator('#research-refresh').click();await expect(page.locator('#tuning-memory-status')).toHaveText('Waiting for free RAM; running candidates continue.');await expect(page.locator('#tuning-worker-counts')).toContainText('96 process capacity');await expect(page.locator('#tuning-active-sets progress')).toHaveCount(2);await expect(page.locator('#tuning-resource-details')).toContainText('Free RAM reported: 4,096 MiB');await expect(page.locator('#tuning-resource-details')).toContainText('Free RAM reserve: 8,192 MiB. Startup copies need additional memory.');
  Object.assign(research.tuning.parallelism,{memory_wait_reason:'initializing',available_memory_mib:32768,initializing_processes:4});await page.locator('#research-refresh').click();await expect(page.locator('#tuning-memory-status')).toHaveText('Starting candidates in batches; running candidates continue.');await expect(page.locator('#tuning-resource-details')).toContainText('Free RAM reported: 32,768 MiB');
  research.tuning.parallelism={...research.tuning.parallelism,memory_waiting:false,memory_wait_reason:null,active_processes:1,active_threads:1,completed_tasks:2,active_sets:[research.tuning.parallelism.active_sets[1]],workers:[{...workers[0],state:'stopped'},...workers.slice(1)]};await page.locator('#research-refresh').click();await expect(page.locator('#tuning-memory-status')).toBeHidden();await expect(page.locator('#tuning-active-sets progress')).toHaveCount(1);await expect(page.locator('#tuning-active-sets')).not.toContainText('Process 4201');await expect(page.locator('#tuning-affinity-summary')).toContainText('2 of 2 current analytics threads verified pinned');
  const assignmentRegion=page.getByRole('region',{name:'Parameter worker CPU assignments',exact:true});await assignmentRegion.evaluate(element=>element.scrollLeft=element.scrollWidth);await assignmentRegion.screenshot({path:testInfo.outputPath('candidate-process-threads-scrolled.png')});if(testInfo.project.name==='mobile')expect(await assignmentRegion.evaluate(element=>element.scrollLeft>0)).toBe(true);
  research={status:'cancelled',tuning:research.tuning};await page.locator('#research-refresh').click();await expect(page.locator('#tuning-active-sets progress')).toHaveCount(0);await expect(page.locator('#tuning-affinity')).toBeHidden();await expect(page.locator('#tuning-resource-budget')).toBeHidden();expect(errors).toEqual([]);
});

test('Research scope controls save 150 stocks and 50 sets without starting research or trading',async({page},testInfo)=>{
  await signIn(page);const writes=[];page.on('request',request=>{if(['POST','PUT'].includes(request.method()))writes.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  await page.locator('nav [data-page="research"]').click();await expect(page.locator('#research-sample-size')).toBeEnabled();await expect(page.locator('#research-set-count')).toBeEnabled();
  await page.locator('#research-sample-size').fill('150');await page.locator('#research-set-count').fill('50');await page.locator('#research-cpu-affinity').selectOption('automatic');await page.getByRole('button',{name:'Save research settings',exact:true}).click();
  await expect(page.locator('#research-settings-status')).toContainText('saved for the next manual or automatic run');await expect(page.locator('#research-settings-error')).toHaveText('');
  expect(writes).toEqual([{path:'/api/research/settings',body:{research_symbols:150,research_tuning_trials:50,research_cpu_affinity:'automatic'}}]);await expect(page.locator('#research-status')).toHaveText('Ready');await expect(page.locator('#engine-status')).toHaveText('Disconnected');
  await page.locator('#research-settings-form').screenshot({path:testInfo.outputPath('research-scope-150-50.png')});
  await page.reload();await expect(page.locator('#research-sample-size')).toHaveValue('150');await expect(page.locator('#research-set-count')).toHaveValue('50');await expect(page.locator('#research-cpu-affinity')).toHaveValue('automatic');await page.locator('nav [data-page="settings"]').click();await expect(page.locator('#config-research_cpu_affinity')).toHaveValue('automatic');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
});
