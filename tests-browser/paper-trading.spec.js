import {test as base,expect} from '@playwright/test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {once} from 'node:events';
import {ConfigManager} from '../src/config.js';
import {createApp} from '../src/main.js';

const PASSWORD='Paper-toggle-browser-test-only-123!';
const test=base.extend({
  execution:[{}, {option:true}],
  application:async({execution},use)=>{
    const directory=mkdtempSync(join(tmpdir(),'stockpilot-paper-toggle-'));
    let app,server;
    try{
      const manager=new ConfigManager(directory,{});
      await manager.load({password:PASSWORD});
      const settings=Object.keys(execution).length?manager.save(execution):manager.settings;
      app=await createApp({settings,configManager:manager});
      server=app.listen(0,'127.0.0.1');await once(server,'listening');
      await use({app,manager,origin:`http://127.0.0.1:${server.address().port}`,
        saved:()=>JSON.parse(readFileSync(manager.filename,'utf8')),
        configuration:()=>readFileSync(manager.filename,'utf8')});
    }finally{
      const closed=server?once(server,'close'):null;
      server?.close();
      try{await app?.shutdown();}finally{server?.closeAllConnections();if(closed)await closed;}
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      rmSync(directory,{recursive:true,force:true,maxRetries:3});
    }
  },
});

async function settingsPage(page,application){
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===application.origin?route.continue():route.abort());
  await page.goto(application.origin);
  await expect(page).toHaveURL(application.origin+'/login');
  await page.getByLabel('Username',{exact:true}).fill('admin');
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Trading workspace'})).toBeVisible();
  await page.locator('nav [data-page="settings"]').click();
  await expect(page.locator('#paper-trading')).toBeEnabled();
  await expect(page.locator('#config-trading_mode')).toHaveCount(0);
  await expect(page.locator('#config-live_trading_enabled')).toHaveCount(0);
  expect(application.app.state.settings.configured).toBe(false);
  expect(application.app.state.engine.broker).toBeNull();
  return errors;
}

async function saveFromTop(page,application){
  const response=page.waitForResponse(result=>result.url()===application.origin+'/api/config'&&result.request().method()==='PUT');
  await page.locator('#paper-trading-save').click();
  return response;
}

async function expectRestartRequired(page){
  await expect(page.locator('#paper-trading-state')).toContainText('restart required');
  await expect(page.locator('#paper-trading-note')).toContainText('Restart the program');
  await expect(page.locator('#paper-trading')).toBeDisabled();
  await expect(page.locator('#paper-trading-save')).toBeDisabled();
  await expect(page.locator('#config-submit')).toBeDisabled();
}

test('top paper toggle stages live execution across navigation and saves both execution fields',async({page,application},testInfo)=>{
  const errors=await settingsPage(page,application);
  const toggle=page.locator('#paper-trading'),card=page.locator('.paper-trading-panel');
  await expect(toggle).toBeChecked();
  await expect(page.locator('#paper-trading-current')).toHaveText('Current mode: Paper trading');
  await page.evaluate(()=>scrollTo(0,0));
  await expect(toggle).toBeInViewport();
  await expect(page.locator('#paper-trading-save')).toBeInViewport();
  expect(await page.evaluate(()=>scrollY)).toBe(0);
  await page.screenshot({path:testInfo.outputPath('paper-trading-settings-top.png')});
  if(testInfo.project.name==='mobile'){
    const button=await page.locator('#paper-trading-save').boundingBox(),navigation=await page.locator('.sidebar').boundingBox();
    await testInfo.attach('initial-mobile-control-layout',{body:JSON.stringify({button,navigation}),contentType:'application/json'});
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.y+button.height).toBeLessThanOrEqual(navigation.y);
  }
  expect((await card.boundingBox()).y).toBeLessThan((await page.locator('#settings-form').boundingBox()).y);
  await card.screenshot({path:testInfo.outputPath('paper-trading-on.png')});
  await page.locator('#config-min_signal_score').fill('64');
  await toggle.uncheck();
  await expect(page.locator('#paper-trading-state')).toHaveText('Unsaved · live trading');
  await expect(page.locator('#paper-trading-current')).toHaveText('Current mode: Paper trading');
  await expect(page.locator('#paper-trading-note')).toContainText('Unsaved change');
  await page.locator('nav [data-page="overview"]').click();
  await expect(page.locator('#mode-pill')).toHaveText('Paper trading');
  await page.locator('nav [data-page="settings"]').click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#config-min_signal_score')).toHaveValue('64');
  expect(application.saved().trading_mode).toBe('paper');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await card.screenshot({path:testInfo.outputPath('paper-trading-off-staged.png')});
  const response=await saveFromTop(page,application);
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({trading_mode:'live',live_trading_enabled:true,min_signal_score:64});
  await expectRestartRequired(page);
  await expect(page.locator('#paper-trading-current')).toHaveText('Current mode: Paper trading');
  expect(application.saved()).toMatchObject({trading_mode:'live',live_trading_enabled:true,min_signal_score:64});
  expect(application.app.state.engine.mode).toBe('paper');
  expect(application.app.state.engine.running).toBe(false);
  await card.screenshot({path:testInfo.outputPath('paper-trading-restart-required.png')});
  expect(errors).toEqual([]);
});

test.describe('previously enabled live execution',()=>{
  test.use({execution:{trading_mode:'live',live_trading_enabled:true}});
  test('enabling paper trading disables real execution and requires restart',async({page,application},testInfo)=>{
    const errors=await settingsPage(page,application);
    await expect(page.locator('#paper-trading')).not.toBeChecked();
    await expect(page.locator('#paper-trading-current')).toHaveText('Current mode: Live trading');
    await page.locator('#paper-trading').check();
    await expect(page.locator('#paper-trading-state')).toHaveText('Unsaved · paper trading');
    await expect(page.locator('#paper-trading-current')).toHaveText('Current mode: Live trading');
    const response=await saveFromTop(page,application);
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({trading_mode:'paper',live_trading_enabled:false});
    await expectRestartRequired(page);
    await expect(page.locator('#paper-trading-current')).toHaveText('Current mode: Live trading');
    await expect(page.locator('#paper-trading')).toBeChecked();
    expect(application.saved()).toMatchObject({trading_mode:'paper',live_trading_enabled:false});
    expect(application.app.state.engine.mode).toBe('live');
    expect(application.app.state.engine.running).toBe(false);
    await page.locator('.paper-trading-panel').screenshot({path:testInfo.outputPath('live-to-paper-saved.png')});
    expect(errors).toEqual([]);
  });
});

test.describe('saved live mode with real execution disabled',()=>{
  test.use({execution:{trading_mode:'live',live_trading_enabled:false}});
  test('unrelated application settings preserve the disabled execution permission',async({page,application})=>{
    const errors=await settingsPage(page,application);
    await expect(page.locator('#paper-trading')).not.toBeChecked();
    await expect(page.locator('#paper-trading-state')).toHaveText('Live execution disabled');
    await page.locator('#config-min_signal_score').fill('61');
    const pending=page.waitForResponse(result=>result.url()===application.origin+'/api/config'&&result.request().method()==='PUT');
    await page.locator('#config-submit').click();
    const response=await pending,payload=response.request().postDataJSON();
    expect(response.status()).toBe(200);
    expect(payload).not.toHaveProperty('trading_mode');expect(payload).not.toHaveProperty('live_trading_enabled');
    await expectRestartRequired(page);
    expect(application.saved()).toMatchObject({trading_mode:'live',live_trading_enabled:false,min_signal_score:61});
    expect(errors).toEqual([]);
  });
});

test('server rejection while trading leaves saved mode unchanged and shows the top-card error',async({page,application},testInfo)=>{
  const errors=await settingsPage(page,application),before=application.configuration();
  application.app.state.engine.status='running';application.app.state.engine.running=true;
  await page.locator('#paper-trading').uncheck();
  const response=await saveFromTop(page,application);
  expect(response.status()).toBe(409);
  await expect(page.locator('#paper-trading-error')).toContainText('Pause entries and resolve managed exposure');
  await expect(page.locator('#paper-trading-error')).toBeVisible();
  await expect(page.locator('#paper-trading')).toBeEnabled();
  await expect(page.locator('#paper-trading-save')).toBeEnabled();
  await expect(page.locator('#paper-trading')).not.toBeChecked();
  await expect(page.locator('#paper-trading-note')).toContainText('Unsaved change');
  expect(application.configuration()).toBe(before);
  expect(application.saved()).toMatchObject({trading_mode:'paper',live_trading_enabled:false});
  expect(application.app.state.restartRequired).toBe(false);
  expect(application.app.state.engine.running).toBe(true);
  await page.locator('.paper-trading-panel').screenshot({path:testInfo.outputPath('paper-trading-save-rejected.png')});
  expect(errors).toEqual([]);
});

test('another tab saving configuration locks the paper controls while preserving this tab unsaved choice',async({page,application})=>{
  const errors=await settingsPage(page,application),other=await page.context().newPage();
  other.on('pageerror',error=>errors.push(error.message));
  try{
    await other.route('**/*',route=>new URL(route.request().url()).origin===application.origin?route.continue():route.abort());
    await other.goto(application.origin+'/settings');
    await expect(other.locator('#paper-trading')).toBeEnabled();
    await other.locator('#paper-trading').uncheck();
    await expect(other.locator('#paper-trading-state')).toHaveText('Unsaved · live trading');
    await expect(other.locator('#paper-trading-current')).toHaveText('Current mode: Paper trading');
    await page.locator('#config-min_signal_score').fill('61');
    const response=await saveFromTop(page,application);
    expect(response.status()).toBe(200);
    await expectRestartRequired(page);
    await expect(other.locator('#paper-trading')).toBeDisabled();
    await expect(other.locator('#paper-trading-save')).toBeDisabled();
    await expect(other.locator('#config-submit')).toBeDisabled();
    await expect(other.locator('#config-min_signal_score')).toBeDisabled();
    await expect(other.locator('#paper-trading')).not.toBeChecked();
    await expect(other.locator('#paper-trading-current')).toHaveText('Current mode: Paper trading');
    expect(application.saved()).toMatchObject({trading_mode:'paper',live_trading_enabled:false,min_signal_score:61});
    expect(application.app.state.engine.broker).toBeNull();
    expect(errors).toEqual([]);
  }finally{await other.close();}
});
