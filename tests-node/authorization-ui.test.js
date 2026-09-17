import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const script = fs.readFileSync(path.join(import.meta.dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(import.meta.dirname, '../public/index.html'), 'utf8');
const official = 'https://kite.zerodha.com/connect/portfolio/authorise/holdings/test-api-key/request-id';
const initial = () => ({ mode: 'live', status: 'paused', connected: true, configured: true, account_fresh: true,
  holdings_authorization: { required: true, status: 'required', items: [{ symbol: 'INFY', quantity: 7, reason: 'Authorization needed for settled shares' }], message: 'Authorize selected holdings to enable their sale.', checked_at: '2026-09-17T10:00:00+05:30' } });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function element(id = '') {
  const classes = new Set(), attributes = {}, events = {};
  const fields = new Proxy({}, { get(target, key) { return target[key] ||= element(String(key)); } });
  return { id, hidden: true, disabled: false, textContent: '', innerHTML: '', value: '', style: {}, dataset: {}, elements: fields, events,
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
    addEventListener(name, fn) { events[name] = fn; }, setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; delete this[name]; }, querySelector() { return element(); }, focus() {}, select() {}, showModal() {},
  };
}
async function harness({ popupBlocked = false } = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], element(match[1])]));
  const requests = [], sequence = [], windowEvents = {}, documentEvents = {}, popups = [], timers = new Map(); let timer = 0;
  let brokerState = initial(), startResult = { authorization_url: official, request_count: 1, total_count: 1 }, authorizationResult = initial().holdings_authorization;
  let customStart = null;
  const document = { visibilityState: 'visible', getElementById: id => { assert.ok(elements.has(id), `Missing dashboard element ${id}`); return elements.get(id); }, querySelectorAll: () => [], addEventListener: (name, fn) => { documentEvents[name] = fn; } };
  const window = { addEventListener: (name, fn) => { windowEvents[name] = fn; }, open(url, target) {
    sequence.push('open'); if (popupBlocked) return null;
    const popup = { initial: url, target, opener: window, closed: false, navigated: null, location: { replace(value) { popup.navigated = value; sequence.push('navigate'); } }, close() { popup.closed = true; } }; popups.push(popup); return popup;
  } };
  const context = vm.createContext({ document, window, console, URL, URLSearchParams, Intl, AbortController, Date,
    location: { hostname: 'localhost', pathname: '/', hash: '', search: '', assign(url) { sequence.push('dashboard-navigation:' + url); } },
    history: { replaceState() {} }, navigator: {},
    setTimeout(fn) { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    createLiveView: () => ({ start() {}, stop() {} }),
    async fetch(url, options) {
      requests.push({ url, options }); sequence.push('request:' + url);
      let data;
      if (url === '/api/session') data = { csrf: 'runtime-csrf' };
      else if (url === '/api/config') data = { fields: [], values: {}, urls: {} };
      else if (url === '/api/state') data = { state: structuredClone(brokerState), events: [] };
      else if (url === '/api/holdings/authorization/start') { data = customStart ? await customStart() : startResult; if (data.authorization?.required === false) brokerState.holdings_authorization = data.authorization; }
      else if (url === '/api/holdings/authorization/refresh') { data = { authorization: authorizationResult }; brokerState.holdings_authorization = authorizationResult; }
      else throw new Error('Unexpected UI request ' + url);
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    },
  });
  vm.runInContext(script, context, { filename: 'public/app.js' }); await flush();
  return { context, elements, requests, sequence, popups, windowEvents, documentEvents, document,
    run: code => vm.runInContext(code, context),
    setState(value) { brokerState = structuredClone(value); context.nextState = brokerState; vm.runInContext('render(nextState)', context); },
    setStart(value) { startResult = value; }, setAuthorization(value) { authorizationResult = value; }, waitForStart(fn) { customStart = fn; },
  };
}

test('authorization banner is global, escapes broker text and contains no local TPIN/OTP inputs', async () => {
  const h = await harness(); assert.equal(h.elements.get('holdings-authorization').hidden, false);
  assert.match(h.elements.get('holdings-authorization-items').innerHTML, /INFY/); assert.match(h.elements.get('holdings-authorization-items').innerHTML, /7 shares/);
  h.run("showPage('settings');settingsDirty=true;configDirty=true;document.getElementById('settings-form').elements.managed_symbols.value='UNSAVED';");
  const next = initial(); next.holdings_authorization.items = [{ symbol: '<script>bad</script>', quantity: 3, reason: '<img src=x>' }]; h.setState(next);
  assert.equal(h.elements.get('holdings-authorization').hidden, false); assert.match(h.elements.get('holdings-authorization-items').innerHTML, /&lt;script&gt;/); assert.doesNotMatch(h.elements.get('holdings-authorization-items').innerHTML, /<script>|<img/);
  assert.equal(h.run("document.getElementById('settings-form').elements.managed_symbols.value"), 'UNSAVED'); assert.equal(h.run('configDirty'), true);
  const banner = html.slice(html.indexOf('<section id="holdings-authorization"'), html.indexOf('<section class="page"'));
  assert.match(banner, /Enter TPIN and OTP only on the Zerodha\/CDSL page/); assert.doesNotMatch(banner, /<input|<textarea|<form/);
});
test('authorize preopens once during click, severs opener, then navigates only to official holdings URL', async () => {
  const h = await harness(); const before = h.sequence.length; await h.run('startHoldingsAuthorization()');
  assert.deepEqual(h.sequence.slice(before), ['open', 'request:/api/holdings/authorization/start', 'navigate']);
  assert.equal(h.popups.length, 1); assert.equal(h.popups[0].initial, 'about:blank'); assert.equal(h.popups[0].opener, null); assert.equal(h.popups[0].navigated, official);
  const request = h.requests.find(item => item.url.endsWith('/authorization/start')); assert.equal(request.options.method, 'POST'); assert.equal(request.options.headers['X-CSRF-Token'], 'runtime-csrf');
  assert.equal(h.elements.get('holdings-authorization-link').href, official); assert.match(h.elements.get('holdings-authorization-feedback').textContent, /new tab/);
  assert.match(html, /id="holdings-authorization-link"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
});
test('blocked or user-closed popup gives explicit link without navigating dashboard or reopening automatically', async () => {
  const h = await harness({ popupBlocked: true }); h.setStart({ authorization_url: official, request_count: 50, total_count: 72 }); await h.run('startHoldingsAuthorization()');
  assert.equal(h.elements.get('holdings-authorization-link').hidden, false); assert.match(h.elements.get('holdings-authorization-feedback').textContent, /50 of 72/); assert.match(h.elements.get('holdings-authorization-feedback').textContent, /did not open/);
  assert.equal(h.sequence.some(item => item.startsWith('dashboard-navigation:')), false); const opens = h.sequence.filter(item => item === 'open').length; h.setState(initial()); assert.equal(h.sequence.filter(item => item === 'open').length, opens);
  const closed = await harness(); let complete; closed.waitForStart(() => new Promise(resolve => { complete = resolve; }));
  const pending = closed.run('startHoldingsAuthorization()'); await flush(); closed.popups[0].close(); complete({ authorization_url: official }); await pending;
  assert.equal(closed.popups[0].navigated, null); assert.equal(closed.popups.length, 1); assert.equal(closed.elements.get('holdings-authorization-link').hidden, false);
});
test('lookalike hosts, insecure schemes, credentials and unrelated paths never receive authorization navigation', async () => {
  const h = await harness();
  for (const url of ['http://kite.zerodha.com/connect/portfolio/authorise/holdings/a', 'https://kite.zerodha.com.evil.example/connect/portfolio/authorise/holdings/a', 'https://evil.example/connect/portfolio/authorise/holdings/a', 'https://kite.zerodha.com:444/connect/portfolio/authorise/holdings/a', 'https://user@kite.zerodha.com/connect/portfolio/authorise/holdings/a', 'https://kite.zerodha.com/other', 'javascript:alert(1)', '/connect/portfolio/authorise/holdings/a']) {
    h.setStart({ authorization_url: url }); await h.run('startHoldingsAuthorization()');
    assert.equal(h.popups.at(-1).closed, true); assert.equal(h.popups.at(-1).navigated, null); assert.equal(h.elements.get('holdings-authorization-link').hidden, true);
  }
  assert.equal(h.sequence.some(item => item.startsWith('dashboard-navigation:')), false);
});
test('focus and visibility refresh broker authorization with throttling; verification clears banner and stale link', async () => {
  const h = await harness(); await h.run('startHoldingsAuthorization()');
  h.setAuthorization({ required: false, status: 'verified', items: [], message: 'Broker authorization verified.' });
  h.windowEvents.focus(); h.documentEvents.visibilitychange(); await flush();
  assert.equal(h.requests.filter(item => item.url.endsWith('/authorization/refresh')).length, 1); assert.equal(h.popups.length, 1);
  assert.equal(h.requests.find(item => item.url.endsWith('/authorization/refresh')).options.body, '{}');
  assert.equal(h.elements.get('holdings-authorization').hidden, true); assert.equal(h.elements.get('holdings-authorization-link').hidden, true); assert.equal(h.elements.get('holdings-authorization-link').href, undefined);
  assert.match(h.elements.get('toast').textContent, /authorization verified/);
  h.windowEvents.focus(); await flush(); assert.equal(h.requests.filter(item => item.url.endsWith('/authorization/refresh')).length, 1);
});
test('in-flight authorization prevents repeated popup and requests; unavailable state allows an explicit retry', async () => {
  const h = await harness(); let complete; h.waitForStart(() => new Promise(resolve => { complete = resolve; }));
  const pending = h.run('startHoldingsAuthorization()'); await flush(); await h.run('startHoldingsAuthorization()'); await h.run('checkHoldingsAuthorization()'); assert.equal(h.popups.length, 1); assert.equal(h.elements.get('holdings-authorization-start').disabled, true);
  complete({ authorization_url: official }); await pending;
  const next = initial(); next.holdings_authorization.status = 'unavailable'; h.setState(next); assert.equal(h.elements.get('holdings-authorization-start').disabled, false); assert.equal(h.elements.get('holdings-authorization-check').disabled, false);
});
test('manual authorization racing Start closes the blank tab and accepts broker verification without URL', async () => {
  const h = await harness(); h.setStart({ authorization: { required: false, status: 'verified', items: [], message: 'Already authorized with Zerodha.' } });
  await h.run('startHoldingsAuthorization()'); assert.equal(h.popups[0].closed, true); assert.equal(h.popups[0].navigated, null);
  assert.equal(h.elements.get('holdings-authorization').hidden, true); assert.equal(h.elements.get('holdings-authorization-feedback').classList.contains('negative'), false); assert.match(h.elements.get('toast').textContent, /authorization verified/);
});
test('only an explicit Check authorization click marks user confirmation; automatic return checks do not', async () => {
  const h = await harness(); await h.elements.get('holdings-authorization-check').events.click();
  const checks = h.requests.filter(item => item.url.endsWith('/authorization/refresh'));
  assert.equal(checks.length, 1); assert.deepEqual(JSON.parse(checks[0].options.body), { user_confirmed: true });
  h.run('authorizationLastCheck=0'); h.windowEvents.focus(); await flush();
  const all = h.requests.filter(item => item.url.endsWith('/authorization/refresh')); assert.equal(all.length, 2); assert.deepEqual(JSON.parse(all[1].options.body), {});
});
