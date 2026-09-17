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
  await expect(page.locator('#config-fields')).not.toContainText('PAPER_CAPITAL');
  await page.locator('nav [data-page="research"]').click();await expect(page.locator('#research-status')).toHaveText('Ready');
  await expect(page.locator('#research-start')).toBeDisabled();
  await page.locator('nav [data-page="activity"]').click();await expect(page.locator('#activity-list')).toContainText('Administrator signed in');
  await page.locator('#logout').click();await expect(page).toHaveURL(/\/login/);expect(errors).toEqual([]);
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
