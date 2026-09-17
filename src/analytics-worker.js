import {parentPort} from 'node:worker_threads';
import {analyze_batch} from './analytics.js';

parentPort.on('message', ({id, records}) => {
  try { parentPort.postMessage({id, results: analyze_batch(records)}); }
  catch (error) { parentPort.postMessage({id, error: error instanceof Error ? error.message : 'Analysis failed'}); }
});
