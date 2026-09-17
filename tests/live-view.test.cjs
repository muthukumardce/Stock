'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInThisContext } = require('node:vm');
const transportModule = { exports: {} };
runInThisContext(`(function(module) { ${readFileSync(join(__dirname, '../public/live-view.js'), 'utf8')}\n})`, { filename: 'public/live-view.js' })(transportModule);
const createLiveView = transportModule.exports;

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function harness(overrides = {}) {
  let now = 0, sequence = 0, expired = 0;
  const timers = new Map(), requests = [], streams = [], updates = [], statuses = [];
  class Stream {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; streams.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    emit(name, data) { this.listeners[name]?.({data:JSON.stringify(data)}); }
    close() { this.closed = true; }
  }
  const view = createLiveView({
    hostname:'trading.example.com', EventSource:Stream, after:() => 17,
    setTimeout:(callback, delay) => { const id = ++sequence; timers.set(id, {callback, at:now + delay}); return id; },
    clearTimeout:id => timers.delete(id),
    fetchState:({signal}) => {
      const request = {...deferred(), signal}; requests.push(request);
      signal.addEventListener('abort', () => request.reject(new Error('Aborted')));
      return request.promise;
    },
    onUpdate:data => updates.push(data), onStatus:status => statuses.push(status),
    onExpired:() => expired++, ...overrides,
  });
  async function advance(milliseconds) {
    const until = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next; timers.delete(id); now = task.at; task.callback(); await flush();
    }
    now = until; await flush();
  }
  return {view, requests, streams, updates, statuses, advance, timers, get expired() { return expired; }};
}

test('Quick Tunnel polls fresh state without opening SSE or overlapping requests', async () => {
  const h = harness({hostname:'sample.trycloudflare.com'});
  h.view.start(); h.view.start();
  assert.equal(h.streams.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.statuses.at(-1).text, 'Connecting · polling');
  await h.advance(6000);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({state:{equity:10}, events:[{id:18}]}); await flush();
  assert.equal(h.updates[0].state.equity, 10);
  assert.deepEqual(h.statuses.at(-1), {text:'Live view · polling', color:'green'});
  await h.advance(1999); assert.equal(h.requests.length, 1);
  await h.advance(1); assert.equal(h.requests.length, 2);
  h.view.stop(); await flush();
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test('normal hosts use SSE, and a silent stream falls back after its last update', async () => {
  const h = harness(); h.view.start();
  assert.equal(h.streams[0].url, '/api/stream?after=17');
  assert.equal(h.statuses.at(-1).color, 'amber');
  h.streams[0].emit('update', {state:{equity:20}, events:[]});
  assert.equal(h.statuses.at(-1).text, 'Live view · stream');
  await h.advance(14000); assert.equal(h.requests.length, 0);
  await h.advance(1000);
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({state:{equity:21}}); await flush();
  assert.equal(h.updates.at(-1).state.equity, 21);
  assert.equal(h.statuses.at(-1).text, 'Live view · polling');
  h.view.stop();
});

test('SSE errors fall back, failed polling retries, and session expiry stops all updates', async () => {
  const h = harness(); h.view.start();
  h.streams[0].emit('error'); h.streams[0].emit('error');
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error('Offline')); await flush();
  assert.equal(h.statuses.at(-1).text, 'Reconnecting · polling');
  await h.advance(2000);
  assert.equal(h.requests.length, 2);
  h.requests[1].reject(Object.assign(new Error('Expired'), {status:401})); await flush();
  assert.equal(h.expired, 1);
  await h.advance(60000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.timers.size, 0);
});

test('a hanging polling request is aborted and retried', async () => {
  const h = harness({EventSource:undefined}); h.view.start();
  await h.advance(10000);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.statuses.at(-1).text, 'Reconnecting · polling');
  await h.advance(2000);
  assert.equal(h.requests.length, 2);
  h.view.stop();
});

test('stopping and restarting discards responses from the previous transport', async () => {
  const h = harness({hostname:'example.trycloudflare.com'}); h.view.start();
  h.requests[0].resolve({state:{equity:1}});
  h.view.stop(); h.view.start(); await flush();
  assert.equal(h.updates.length, 0);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({state:{equity:2}}); await flush();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].state.equity, 2);
  h.view.stop(); await h.advance(60000);
  assert.equal(h.requests.length, 2);
});

test('SSE session expiry closes the stream; late callbacks cannot restart polling', async () => {
  const h = harness(); h.view.start();
  h.streams[0].emit('expired');
  h.streams[0].emit('error');
  h.streams[0].emit('update', {state:{equity:99}});
  assert.equal(h.expired, 1);
  assert.equal(h.streams[0].closed, true);
  await h.advance(60000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.updates.length, 0);
});

test('malformed stream data and a missing EventSource each use polling', () => {
  const h = harness(); h.view.start();
  h.streams[0].emit('update', {events:[]});
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.requests.length, 1);
  h.view.stop();
  const unsupported = harness({EventSource:undefined}); unsupported.view.start();
  assert.equal(unsupported.requests.length, 1);
  unsupported.view.stop();
});
