/** Synthetic capacity check only: no broker, account, credentials or database. */
import {performance} from 'node:perf_hooks';
import {AnalyticsPool} from '../src/analytics.js';
import {Candle} from '../src/strategy.js';
const count=Number(process.argv[2]??9000);
if(!Number.isInteger(count)||count<1||count>9000)throw new Error('Choose 1–9000 synthetic symbols');
const pool=new AnalyticsPool(0,4,32),make=(date,n)=>Array.from({length:n},(_,i)=>{
  const price=100+i*.01+Math.sin(i)*.1;
  return new Candle(new Date(+new Date(date+'T09:15:00+05:30')+i*300000),price,price+.3,price-.3,price+.1,1000+i*10);
});
const previous=make('2026-09-16',75),bars=make('2026-09-17',60),jobs=[];
let peakWorkers=0,peakMemory=0;
const sample=()=>{peakWorkers=Math.max(peakWorkers,pool.workers.size);peakMemory=Math.max(peakMemory,process.memoryUsage().rss);};
const sampler=setInterval(sample,100),started=performance.now(),cpu=process.cpuUsage();
try{
  // Keep at most three batches per worker admitted, matching the pool bound.
  let completed=0,valid=0;
  for(let offset=0;offset<count;){
    jobs.length=0;
    for(let batch=0;batch<pool.worker_limit*3&&offset<count;batch++){
      const records=Array.from({length:Math.min(32,count-offset)},(_,i)=>({token:offset+i+1,strategy:'intraday',bars,bar_time:bars.at(-1).time.toISOString(),generation:0,queued_at:0,
        strategy_options:{enhanced_signals:true},context:{previous_bars:previous,benchmark_bars:bars,as_of:'2026-09-17T14:15:00+05:30'}}));
      offset+=records.length;jobs.push(pool.analyze(records));sample();
    }
    for(const result of await Promise.all(jobs)){completed+=result.length;valid+=result.filter(r=>r.metrics.data_valid).length;}
  }
  const usage=process.cpuUsage(cpu);
  console.log(JSON.stringify({synthetic:true,broker_requests:0,symbols:completed,valid_analysis:valid,wall_seconds:Number(((performance.now()-started)/1000).toFixed(3)),cpu_seconds:(usage.user+usage.system)/1e6,
    peak_workers:peakWorkers,peak_process_memory_gib:Number((peakMemory/2**30).toFixed(3)),capacity:pool.snapshot().capacity,worker_limit:pool.worker_limit},null,2));
  if(completed!==count||valid!==count)process.exitCode=1;
}finally{clearInterval(sampler);await pool.close();}
