import {parentPort, workerData} from 'node:worker_threads';
import {KiteTicker} from 'kiteconnect';

// Each SDK instance must live in a separate isolate: the official SDK currently
// stores its socket, callbacks and reconnect timers in module-level variables.
const ticker = new KiteTicker({api_key: workerData.api_key, access_token: workerData.access_token,
  reconnect: true, max_retry: 50, max_delay: 60});
const status = connected => parentPort.postMessage({type: 'status', connected});
ticker.on('connect', () => {
  ticker.subscribe(workerData.tokens);
  ticker.setMode(ticker.modeFull, workerData.tokens);
  status(true);
});
ticker.on('ticks', ticks => parentPort.postMessage({type: 'ticks', ticks}));
ticker.on('order_update', order => parentPort.postMessage({type: 'order', order}));
for (const event of ['error', 'close', 'disconnect', 'noreconnect']) ticker.on(event, () => status(false));
ticker.connect();
