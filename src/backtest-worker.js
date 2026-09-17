import { parentPort, workerData } from 'node:worker_threads';
import { compareStrategies } from './backtest.js';

let lastProgress = 0;
try {
  const result = compareStrategies(workerData.dataset, workerData.options, {
    onProgress: progress => {
      if (Date.now() - lastProgress >= 100 || progress.progress === 1) {
        lastProgress = Date.now(); parentPort.postMessage({ type: 'progress', ...progress });
      }
    },
  });
  parentPort.postMessage({ type: 'complete', result });
} catch (error) {
  parentPort.postMessage({ type: 'failed', error: String(error.message || 'Research failed').slice(0, 1000) });
}
parentPort.close();
