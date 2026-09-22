import {test,expect} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {ConfigManager} from '../src/config.js';
import {createApp} from '../src/main.js';

test('daily risk slider previews, preserves edits and saves through the existing restart workflow',async({page},testInfo)=>{
  const root=mkdtempSync(join(tmpdir(),'stockpilot-risk-browser-')),password='Risk-browser-only-123!';
  let app,server;
  try{
    const manager=new ConfigManager(root,{}),settings=await manager.load({password});
    app=await createApp({settings,configManager:manager});server=app.listen(0,'127.0.0.1');await once(server,'listening');
    const origin=`http://127.0.0.1:${server.address().port}`,errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.method()==='PUT'&&request.url().endsWith('/api/config'))writes.push(request.postDataJSON());});
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.goto(origin);await page.getByLabel('Username',{exact:true}).fill('admin');await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in'}).click();
    await page.locator('nav [data-page="settings"]').click();
    await expect(page.locator('#risk-preset')).toBeVisible();await expect(page.locator('#daily-risk-value')).toHaveText('1%');
    await expect(page.locator('#config-risk_per_trade_pct')).toHaveValue('0.0025');
    await page.evaluate(()=>{liveView.stop();render({...state,capital:100000,equity:110000,mode:'paper',broker_available_cash:90000,strategy_settings:{intraday_enabled:true,intraday_allocation_pct:1,swing_enabled:false,swing_allocation_pct:0},decision_controls:{portfolio:{reference_assets:150000}}});});
    await page.locator('#daily-risk-slider').focus();await page.locator('#daily-risk-slider').press('End');
    await expect(page.locator('#daily-risk-value')).toHaveText('10%');await expect(page.locator('#config-daily_loss_pct')).toHaveValue('0.1');
    await expect(page.locator('#config-risk_per_trade_pct')).toHaveValue('0.02');await expect(page.locator('#config-max_position_pct')).toHaveValue('0.2');
    await expect(page.locator('#config-max_account_stock_pct')).toHaveValue('0.2');await expect(page.locator('#config-max_account_risk_pct')).toHaveValue('0.1');
    await expect(page.locator('#config-max_spread_pct')).toHaveValue('0.003');
    await expect(page.locator('#risk-preset-preview')).toContainText('10,000.00');await expect(page.locator('#risk-preset-preview')).toContainText('2,000.00');await expect(page.locator('#risk-preset-preview')).toContainText('15,000.00');
    expect(writes).toHaveLength(0);
    await page.evaluate(()=>render({...state,capital:120000}));
    await expect(page.locator('#daily-risk-slider')).toHaveValue('10');await expect(page.locator('#risk-preset-preview')).toContainText('12,000.00');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
    await page.locator('#risk-preset').screenshot({path:testInfo.outputPath('daily-risk-preview.png')});
    app.state.engine.running=true;app.state.engine.status='running';
    await page.locator('#risk-preset-save').click();await expect(page.locator('#config-error')).toContainText('Pause entries');
    expect(app.state.restartRequired).toBe(false);expect(manager.candidate({}).daily_loss_pct).toBe(.01);
    app.state.engine.running=false;app.state.engine.status='paused';
    await page.locator('#risk-preset-save').click();
    await expect(page.locator('#daily-risk-slider')).toBeDisabled();await expect(page.locator('#risk-preset-status')).toHaveText('Restart required');
    expect(app.state.restartRequired).toBe(true);
    const saved=manager.candidate({});
    expect(saved.daily_loss_pct).toBe(.1);expect(saved.risk_per_trade_pct).toBe(.02);expect(saved.max_account_risk_pct).toBe(.1);expect(saved.max_position_pct).toBe(.2);expect(saved.max_account_stock_pct).toBe(.2);
    expect(saved.trading_mode).toBe('paper');expect(saved.live_trading_enabled).toBe(false);expect(saved.max_spread_pct).toBe(.003);
    expect(writes).toHaveLength(2);expect(writes[1].trading_mode).toBeUndefined();expect(errors).toEqual([]);
    const reloaded=await new ConfigManager(root,{}).load();expect(reloaded.daily_loss_pct).toBe(.1);expect(reloaded.risk_per_trade_pct).toBe(.02);
  }finally{
    server?.close();await app?.shutdown();server?.closeAllConnections();
    expect(root.startsWith(join(tmpdir(),'stockpilot-risk-browser-'))).toBeTruthy();rmSync(root,{recursive:true,force:true,maxRetries:3});
  }
});
