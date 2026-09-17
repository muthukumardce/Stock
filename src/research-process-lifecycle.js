/** Main-server ownership survives forced termination of the research Worker. */
import {setTimeout as delay} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {reapResearchProcess} from './research-process-reaper.js';

const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
// Without the optional native adapter, a Unix zombie has already released its
// CPU and address space. Avoid mistaking that OS record for running analytics.
export function defunctResearchProcess(pid,{platform=process.platform,read=readFileSync,run=spawnSync}={}){
  if(!Number.isSafeInteger(pid)||pid<=0||pid>2**31-1)return false;
  try{
    if(platform==='linux'){
      const stat=read(`/proc/${pid}/stat`,'utf8');return /^[ZX] /.test(stat.slice(stat.lastIndexOf(')')+2));
    }
    if(platform==='darwin'){
      const result=run('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8',timeout:1000,maxBuffer:1024,stdio:['ignore','pipe','ignore'],shell:false,windowsHide:true});
      return !result.error&&result.status===0&&/^Z/.test(result.stdout.trim());
    }
  }catch{}
  return false;
}
export class ResearchProcessLifecycle{
  constructor({isAlive=alive,kill=pid=>process.kill(pid,'SIGKILL'),reap=reapResearchProcess,isDefunct=defunctResearchProcess,pause=delay,now=()=>performance.now(),timeoutMs=5000}={}){
    this.pids=new Set();this.isAlive=isAlive;this.kill=kill;this.reap=reap;this.isDefunct=isDefunct;this.pause=pause;this.now=now;this.timeoutMs=timeoutMs;
  }
  observe(event){
    const pid=event?.process_id;
    if(!Number.isSafeInteger(pid)||pid<=0||pid>2**31-1||pid===process.pid)return;
    if(event.event==='created')this.pids.add(pid);
    else if(event.event==='stopped')this.pids.delete(pid);
  }
  remaining(){for(const pid of this.pids)if(!this.isAlive(pid))this.pids.delete(pid);return this.pids.size;}
  async retire(){
    const started=this.now();
    // These are only PIDs reported by this run's child-process pool. Normal
    // completion has already joined them and sent stopped events; this handles
    // the fallback when its owning Worker could not complete that cleanup.
    for(const pid of this.pids){
      // An exited Unix child may still have a zombie PID after its coordinator
      // handle disappeared. Reap it before considering a signal to a cached PID.
      const result=this.reap(pid,{coordinatorExited:true});
      if(result.status==='reaped'||result.status==='unavailable'&&this.isDefunct(pid)||!this.isAlive(pid)){this.pids.delete(pid);continue;}
      try{this.kill(pid);}catch(error){if(error.code!=='ESRCH')throw new Error('Could not stop all candidate processes; research cannot restart until they exit.');}
    }
    while(this.pids.size){
      for(const pid of this.pids){
        const result=this.reap(pid,{coordinatorExited:true});
        if(result.status==='reaped'||result.status==='unavailable'&&this.isDefunct(pid))this.pids.delete(pid);
      }
      if(!this.remaining())break;
      if(this.now()-started>=this.timeoutMs)throw new Error('Candidate processes have not exited; research cannot restart until they exit.');
      await this.pause(25);
    }
  }
}
