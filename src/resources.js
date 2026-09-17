import os from 'node:os';
import {statfsSync} from 'node:fs';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {detectCapacity} from './capacity.js';
import {monotonic} from './util.js';
export class ResourceMonitor {
  constructor(dataDir=process.cwd()){this.dataDir=dataDir;this.capacity=detectCapacity();this.previous=null;this.at=-Infinity;this.current={};this.delay=monitorEventLoopDelay({resolution:20});this.delay.enable();}
  snapshot(){
    const now=monotonic();
    if(now-this.at<2)return this.current;
    const cpus=os.cpus(),total=cpus.reduce((n,c)=>n+Object.values(c.times).reduce((a,b)=>a+b,0),0),idle=cpus.reduce((n,c)=>n+c.times.idle,0);
    const percent=this.previous&&total>this.previous.total?100*(1-(idle-this.previous.idle)/(total-this.previous.total)):0;
    this.previous={total,idle};this.at=now;
    let disk_free_mib=null;try{const disk=statfsSync(this.dataDir);disk_free_mib=disk.bavail*disk.bsize/2**20;}catch{/* Unknown capacity is visible and prevents additional live risk. */}
    const event_loop_delay_ms=this.delay.max/1e6;this.delay.reset();
    this.current={logical_cpus:this.capacity.logical_cpus,available_cpus:this.capacity.available_cpus,capacity_scope:this.capacity.scope,cpu_sampled_cpus:cpus.length,cpu_percent:Math.max(0,Math.min(100,percent)),memory_total_gib:os.totalmem()/2**30,memory_used_gib:(os.totalmem()-os.freemem())/2**30,memory_percent:100*(1-os.freemem()/os.totalmem()),memory_free_mib:os.freemem()/2**20,server_memory_mib:process.memoryUsage().rss/2**20,disk_free_mib,event_loop_delay_ms,uptime_seconds:process.uptime()};return this.current;
  }
  close(){this.delay.disable();}
}
