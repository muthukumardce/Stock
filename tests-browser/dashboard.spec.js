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

test('comparison worker telemetry distinguishes per-candle stock analysis from parameter candidates',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);await page.evaluate(()=>{liveView.stop();render({connected:true,configured:true,status:'paused',mode:'paper',signals:[]});});
  const comparison={phase:'baseline',interval:'5minute',symbol_count:150,processed_bars:15000,total_bars:200000,capacity:{worker_limit:32},parallelism:{worker_limit:32,active_workers:12,batch_completed_symbols:70,batch_total_symbols:150,batch_timestamp:'2026-09-16T10:15:00+05:30'}};
  let research={status:'running',progress:24,started_at:'2026-09-17T10:00:00+05:30',current_task:{title:'Comparing baseline rules',detail:'Intraday comparison · using 12 workers with capacity for 32.'},comparison};
  await page.route('**/api/research',route=>route.fulfill({json:research}));await page.locator('nav [data-page="research"]').click();
  await expect(page.locator('#research-comparison-title')).toHaveText('Baseline comparison workers');await expect(page.locator('#research-comparison-details')).toContainText('12 active / 32 capacity');await expect(page.locator('#research-comparison-details')).toContainText('15,000 / 2,00,000');await expect(page.locator('#research-comparison-details')).not.toContainText('70 / 150');await expect(page.locator('#research-comparison-candle')).not.toHaveAttribute('open');await expect(page.locator('#page-research progress')).toHaveCount(1);
  research={...research,progress:28,progress_detail:{stage:'Enhanced comparison',stage_progress:8.025,completed:16050,total:200000,unit:'candles'},current_task:{title:'Comparing enhanced rules',detail:'Intraday comparison · using 4 workers with capacity for 32.'},comparison:{...comparison,phase:'enhanced',processed_bars:16050,parallelism:{...comparison.parallelism,active_workers:4,batch_completed_symbols:10,batch_timestamp:'2026-09-16T10:20:00+05:30'}}};await page.locator('#research-refresh').click();
  await expect(page.locator('#research-comparison-title')).toHaveText('Enhanced comparison workers');await expect(page.locator('#research-comparison-details')).toContainText('4 active / 32 capacity');await expect(page.locator('#research-comparison-details')).toContainText('16,050 / 2,00,000');await expect(page.locator('#research-progress-label')).toHaveText('Overall work: 28%');await expect(page.locator('#research-progress-detail')).toHaveText('Enhanced comparison: 8% · 16,050 / 2,00,000 candles');await page.locator('#research-comparison-candle summary').click();await expect(page.locator('#research-comparison-candle-details')).toContainText('10:20:00 IST');await expect(page.locator('#research-comparison-candle-details')).toContainText('10 / 150');await page.locator('.research-status-panel').screenshot({path:testInfo.outputPath('comparison-workers.png')});
  research={...research,status:'cancelled'};await page.locator('#research-refresh').click();await expect(page.locator('#research-comparison')).toBeHidden();await expect(page.locator('#page-research progress')).toHaveCount(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)).toBe(false);expect(errors).toEqual([]);
});

test('Research scope controls save 150 index stocks without starting research or trading',async({page},testInfo)=>{
  await signIn(page);const writes=[];page.on('request',request=>{if(['POST','PUT'].includes(request.method()))writes.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  await page.locator('nav [data-page="research"]').click();await expect(page.locator('#research-sample-size')).toBeEnabled();
  await page.locator('#research-sample-size').fill('150');await page.locator('#research-cpu-affinity').selectOption('automatic');await page.getByRole('button',{name:'Save research settings',exact:true}).click();
  await expect(page.locator('#research-settings-status')).toContainText('saved for the next manual or automatic run');await expect(page.locator('#research-settings-error')).toHaveText('');
  expect(writes).toEqual([{path:'/api/research/settings',body:{research_symbols:150,research_cpu_affinity:'automatic'}}]);await expect(page.locator('#research-status')).toHaveText('Ready');await expect(page.locator('#engine-status')).toHaveText('Disconnected');
  await page.locator('#research-settings-form').screenshot({path:testInfo.outputPath('research-scope-150.png')});
  await page.reload();await expect(page.locator('#research-sample-size')).toHaveValue('150');await expect(page.locator('#research-cpu-affinity')).toHaveValue('automatic');await page.locator('nav [data-page="settings"]').click();await expect(page.locator('#config-research_cpu_affinity')).toHaveValue('automatic');
  await expect(page.locator('[id^="config-research_tuning"]')).toHaveCount(0);
  await page.locator('nav [data-page="research"]').click();await expect(page.locator('[id^="tuning-"]')).toHaveCount(0);
  await page.locator('#research-all-symbols').check();await expect(page.locator('#research-sample-size')).toBeDisabled();
  await page.getByRole('button',{name:'Save research settings',exact:true}).click();
  await expect(page.locator('#research-settings-status')).toContainText('saved for the next manual or automatic run');
  expect(writes.at(-1)).toEqual({path:'/api/research/settings',body:{research_symbols:0,research_cpu_affinity:'automatic'}});
  await page.reload();await expect(page.locator('#research-all-symbols')).toBeChecked();await expect(page.locator('#research-sample-size')).toBeDisabled();
  await expect(page.locator('#research-start')).toBeDisabled();
  await page.locator('#research-settings-form').screenshot({path:testInfo.outputPath('research-all-constituents.png')});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
});
