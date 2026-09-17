import os from 'node:os';
export class ResourceMonitor {
  constructor(){this.previous=null;this.at=0;this.current={};}
  snapshot(){
    if(Date.now()-this.at<2000)return this.current;
    const cpus=os.cpus(),total=cpus.reduce((n,c)=>n+Object.values(c.times).reduce((a,b)=>a+b,0),0),idle=cpus.reduce((n,c)=>n+c.times.idle,0);
    const percent=this.previous&&total>this.previous.total?100*(1-(idle-this.previous.idle)/(total-this.previous.total)):0;
    this.previous={total,idle};this.at=Date.now();
    this.current={logical_cpus:cpus.length,cpu_percent:Math.max(0,Math.min(100,percent)),memory_total_gib:os.totalmem()/2**30,memory_used_gib:(os.totalmem()-os.freemem())/2**30,memory_percent:100*(1-os.freemem()/os.totalmem()),server_memory_mib:process.memoryUsage().rss/2**20};return this.current;
  }
}
