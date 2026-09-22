import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import {once} from 'node:events';
import {createKiteTransport} from '../src/kite-transport.js';
import {KiteBroker} from '../src/broker.js';
import {exchangeToken} from '../src/main.js';

async function localServer(t, handler, host = '::') {
  const server = http.createServer(handler);
  server.listen({host, port: 0, ipv6Only: host === '::1'});
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
  return `http://localhost:${server.address().port}`;
}

test('Kite transport uses IPv4 and preserves POST bodies without changing global fetch or DNS', async t => {
  const originalFetch = globalThis.fetch, originalOrder = dns.getDefaultResultOrder();
  let seen;
  const url = await localServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen = {address: req.socket.remoteAddress, method: req.method, body, header: req.headers['x-kite-version']};
    res.end('received');
  });
  const transport = createKiteTransport(); t.after(() => transport.close());
  const response = await transport.fetch(url, {method: 'POST', headers: {'X-Kite-Version': '3'},
    body: new URLSearchParams({quantity: '2'}), signal: AbortSignal.timeout(2000), redirect: 'error'});
  assert.equal(await response.text(), 'received');
  assert.deepEqual(seen, {address: '::ffff:127.0.0.1', method: 'POST', body: 'quantity=2', header: '3'});
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(dns.getDefaultResultOrder(), originalOrder);
  await transport.close();
  await transport.close();
});

test('Kite transport does not fall back to an IPv6-only listener', async t => {
  let received = 0;
  const url = await localServer(t, (_req, res) => {received++; res.end('unexpected');}, '::1');
  const transport = createKiteTransport(); t.after(() => transport.close());
  await assert.rejects(transport.fetch(url, {signal: AbortSignal.timeout(2000)}));
  assert.equal(received, 0);
});

test('Kite transport preserves cancellation and does not retry an interrupted POST', async t => {
  let received = 0;
  const url = await localServer(t, req => {received++; req.socket.destroy();});
  const transport = createKiteTransport(); t.after(() => transport.close());
  await assert.rejects(transport.fetch(url, {method: 'POST', body: 'order', signal: AbortSignal.timeout(2000)}));
  assert.equal(received, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transport.fetch(url, {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(received, 1);
});

test('broker REST and login exchange both use the IPv4 transport', async t => {
  const requests = [], addresses = [];
  const url = await localServer(t, (req, res) => {
    addresses.push(req.socket.remoteAddress);
    req.resume(); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({status: 'success', data: {access_token: 'test-token'}}));
  });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (target, options) => {
    requests.push({target, options});
    // All requests in this test stay on the loopback server, including login.
    return fetch(url, options);
  });
  const broker = new KiteBroker('test-key', 'test-token'); t.after(() => broker.close());
  await broker.call('profile');
  await exchangeToken({kite_api_key: 'test-key', kite_api_secret: 'test-secret'}, 'test-request');
  assert.deepEqual(addresses, ['::ffff:127.0.0.1', '::ffff:127.0.0.1']);
  assert.deepEqual(requests.map(r => r.target), ['https://api.kite.trade/user/profile', 'https://api.kite.trade/session/token']);
  for (const {options} of requests) {
    assert.ok(options.dispatcher); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
  }
  assert.equal(requests[0].options.headers.Authorization, 'token test-key:test-token');
  assert.equal(requests[1].options.body.get('request_token'), 'test-request');
});
