import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../src/main.js';
import { ConfigManager, DEFAULTS, Settings } from '../src/config.js';
import { TradingEngine } from '../src/trading.js';
import { AnalyticsPool } from '../src/analytics.js';
import { Store } from '../src/storage.js';
import { ResourceMonitor } from '../src/resources.js';

const source = path.resolve(import.meta.dirname, '..');
const PASSWORD = 'Runtime-test-password-only!';
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpilot-node-runtime-'));
  t.after(() => {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'stockpilot-node-runtime-')));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return directory;
}
function isolatedEnvironment() {
  const environment = { ...process.env };
  for (const key of [...Object.keys(DEFAULTS).map(key => key.toUpperCase()), 'KITE_API_KEY', 'KITE_API_SECRET', 'KITE_USER_ID', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'NODE_OPTIONS', 'PUBLIC_URL', 'APP_ENV', 'PAPER_CAPITAL', 'LIVE_CAPITAL']) delete environment[key];
  return environment;
}
function launch(directory, args, { ipc = false } = {}) {
  const child = spawn(process.execPath, args, { cwd: directory, env: isolatedEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completion, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function run(directory, args) {
  const started = launch(directory, args); const timeout = setTimeout(() => started.child.kill(), 20000);
  try { return await started.completion; } finally { clearTimeout(timeout); }
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function health(origin, processState) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) throw new Error(`Runtime exited during startup: ${processState.stderr}`);
    try { const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(400) }); if (response.ok) return response; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Local runtime did not become healthy');
}

test('real application and default engine serve disconnected dashboard without credentials or broker requests', async t => {
  const directory = temporary(t), manager = new ConfigManager(directory, {}), settings = await manager.load({ password: PASSWORD });
  assert.ok(settings instanceof Settings); assert.equal(settings.configured, false);
  const originalFetch = globalThis.fetch; let externalRequests = 0;
  globalThis.fetch = (input, ...args) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { externalRequests++; throw new Error('External network forbidden in runtime test'); }
    return originalFetch(input, ...args);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const app = await createApp({ settings, configManager: manager });
  assert.ok(app.state.engine instanceof TradingEngine);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  let closed = false;
  const close = async () => { if (closed) return; closed = true; server.close(); await app.shutdown(); server.closeAllConnections(); };
  t.after(close);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/health'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok', safe_to_stop: true });
  assert.equal((await fetch(origin + '/login')).status, 200);
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie }, state = (await (await fetch(origin + '/api/state', { headers })).json()).state;
  assert.equal(state.connected, false); assert.equal(state.configured, false); assert.equal(state.capital, 0); assert.equal(state.status, 'disconnected');
  assert.equal(state.performance.live_workers, 0); assert.equal(state.performance.execution_workers, 1);
  assert.ok(state.performance.worker_limit >= 1); assert.ok(state.resources.logical_cpus >= 1); assert.equal(app.state.engine.broker, null);
  const { csrf } = await (await fetch(origin + '/api/session', { headers })).json();
  const start = await fetch(origin + '/api/trading/start', { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}' });
  assert.equal(start.status, 409); assert.equal(app.state.engine.broker, null); assert.equal(externalRequests, 0);
  await close(); assert.equal(app.state.engine.analytics.closed, true); assert.equal(app.state.engine.analytics.workers.size, 0);
  // The real application releases its database process lock on graceful shutdown.
  const restarted = await createApp({ settings, configManager: manager }); await restarted.shutdown(); assert.equal(externalRequests, 0);
});

test('resource defaults support one-, two-, and four-CPU machines without zero-worker pools', async () => {
  assert.equal(DEFAULTS.analytics_workers, 0); assert.equal(DEFAULTS.analytics_reserve_cpus, 4);
  for (const logical_cpus of [1, 2, 4, 8, 192]) {
    const pool = new AnalyticsPool(DEFAULTS.analytics_workers, DEFAULTS.analytics_reserve_cpus, DEFAULTS.analytics_batch_size, { logical_cpus });
    assert.equal(pool.worker_limit, Math.max(1, logical_cpus - 4)); assert.equal(pool.workers.size, 0); await pool.close();
  }
  const explicit = new AnalyticsPool(100, 4, 32, { logical_cpus: 2 }); assert.equal(explicit.worker_limit, 2); await explicit.close();
});

test('machine-health refresh survives backward and forward wall-clock corrections',t=>{
  let wall=Date.parse('2026-09-17T12:00:00Z'),elapsed=100,free=1024*2**20;
  t.mock.method(Date,'now',()=>wall);
  t.mock.method(process.hrtime,'bigint',()=>BigInt(elapsed*1e9));
  t.mock.method(os,'freemem',()=>free);
  const monitor=new ResourceMonitor(temporary(t));t.after(()=>monitor.close());
  const healthy=monitor.snapshot();assert.equal(healthy.memory_free_mib,1024);
  wall-=3600000;elapsed+=3;free=128*2**20;
  const low=monitor.snapshot();assert.equal(low.memory_free_mib,128,'Backward clock correction must not hide low memory');
  wall+=7200000;elapsed+=1;free=512*2**20;
  assert.equal(monitor.snapshot(),low,'Wall-clock jumps must not alter the sampling interval');
  elapsed+=1;assert.equal(monitor.snapshot().memory_free_mib,512);
});

test('copied Node CLI setup/check/start and SIGTERM shutdown work with no Python or broker connectivity', { timeout: 30000 }, async t => {
  const directory = temporary(t);
  for (const entry of ['src', 'public', '.env.example', 'package.json']) fs.cpSync(path.join(source, entry), path.join(directory, entry), { recursive: true });
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Only a temporary fixture imports the network guard. Real application source
  // remains unmodified; any attempted external connection makes the test fail.
  fs.writeFileSync(path.join(directory, 'runtime-network-guard.mjs'), `
import net from 'node:net';
let external = 0;
const local = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host));
const denied = () => { external++; throw new Error('External network forbidden by runtime test'); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => { const url = new URL(typeof input === 'string' ? input : input.url || input); if (!local(url.hostname)) return denied(); return originalFetch(input, ...args); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) { const first = Array.isArray(args[0]) ? args[0][0] : args[0]; const host = typeof first === 'object' ? first.host : typeof args[1] === 'string' ? args[1] : 'localhost'; if (!(typeof first === 'object' && first.path) && !local(host || 'localhost')) return denied(); return connect.apply(this, args); };
process.on('exit', () => { if (external) process.exitCode = 99; });
`);
  const guarded = args => ['--import', './runtime-network-guard.mjs', ...args];
  const setup = await run(directory, guarded(['src/cli.js', 'setup'])); assert.equal(setup.code, 0, setup.stderr);
  const password = setup.stdout.match(/Initial password: ([^\r\n]+)/)?.[1]; assert.ok(password);
  const envKeys = fs.readFileSync(path.join(directory, '.env'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split('=')[0]);
  assert.deepEqual(envKeys, ['KITE_API_KEY', 'KITE_API_SECRET', 'KITE_USER_ID']);
  const filename = path.join(directory, 'config', 'settings.json'), saved = JSON.parse(fs.readFileSync(filename, 'utf8')); assert.equal(saved.port, 3000); assert.equal(saved.trading_mode, 'paper'); assert.equal(saved.live_trading_enabled, false); assert.ok(saved.admin_password_hash.startsWith('$argon2'));
  saved.port = await freePort(); fs.writeFileSync(filename, JSON.stringify(saved));
  const secondSetup = await run(directory, guarded(['src/cli.js', 'setup'])); assert.equal(secondSetup.code, 0, secondSetup.stderr); assert.doesNotMatch(secondSetup.stdout, /Initial password:/); assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).admin_password_hash, saved.admin_password_hash);
  const check = await run(directory, guarded(['src/cli.js', 'check'])); assert.equal(check.code, 0, check.stderr); assert.match(check.stdout, /Configuration valid/); assert.match(check.stdout, /Kite credentials: not set/);
  // Windows does not deliver child.kill('SIGTERM') to JS handlers. IPC emits the
  // actual registered signal event there; POSIX uses the real operating-system signal.
  fs.writeFileSync(path.join(directory, 'runtime-bootstrap.mjs'), `await import('./src/index.js'); process.on('message', message => { if (message === 'runtime-test-SIGTERM') { process.emit('SIGTERM'); process.disconnect(); } }); process.send?.('runtime-ready');`);
  const running = launch(directory, guarded(['runtime-bootstrap.mjs']), { ipc: true });
  t.after(async () => { if (running.child.exitCode === null) { running.child.kill(); await running.completion; } });
  const origin = `http://127.0.0.1:${saved.port}`; const liveHealth = await health(origin, running); assert.equal((await liveHealth.json()).safe_to_stop, true);
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], liveState = (await (await fetch(origin + '/api/state', { headers: { cookie } })).json()).state;
  assert.equal(liveState.status, 'disconnected'); assert.equal(liveState.configured, false); assert.equal(liveState.performance.live_workers, 0);
  if (process.platform === 'win32') running.child.send('runtime-test-SIGTERM'); else { running.child.disconnect(); running.child.kill('SIGTERM'); }
  const result = await running.completion; assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /SIGTERM: pausing execution and closing the server/);
  const store = new Store(path.join(directory, 'data', 'stockpilot.sqlite3'));
  try { assert.ok(store.events().some(e => e.kind === 'server.stopped')); assert.equal(store.get('kite_session'), null); assert.equal(store.get('bot_state_paper').capital, 0); } finally { store.close(); }
  const after = await run(directory, guarded(['src/cli.js', 'check'])); assert.equal(after.code, 0, after.stderr);
});
