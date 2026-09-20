/** Disposable IPC supervisor; portfolio and analytics each have bounded isolates. */
import {Worker} from 'node:worker_threads';
let running=false,stopping=false,taskId=null,coordinator=null,cancellation=null,terminal=null;
const shutdown=()=>{stopping=true;if(cancellation)Atomics.store(cancellation,0,1);process.exit(0);};
// Losing the owning research Worker closes IPC even while the application main
// process remains alive. Exiting this OS process also retires all nested threads.
process.on('disconnect',shutdown);
function send(message,callback){
  if(!process.connected)return shutdown();
  try{process.send(message,error=>{if(error)shutdown();else callback?.();});}catch{shutdown();}
}
process.on('message',message=>{
  if(message?.type==='cancel'){stopping=true;if(cancellation)Atomics.store(cancellation,0,1);if(!running)shutdown();return;}
  if(message?.type!=='run'||message.protocol!==1||running||!Number.isSafeInteger(message.task_id)||message.task_id<1
    ||!Number.isInteger(message.coordinator_heap_mib)||message.coordinator_heap_mib<512||message.coordinator_heap_mib>12288){
    send({type:'failed',task_id:taskId,code:'worker_protocol',error:'Invalid candidate process request.'},shutdown);return;
  }
  running=true;taskId=message.task_id;cancellation=new Int32Array(new SharedArrayBuffer(4));
  try{
    // Process CLI heap flags override nested Worker limits in V8, even with
    // execArgv:[]. Set the portfolio limit on its own isolate instead. The IPC
    // supervisor releases its deserialized context when this handler returns.
    coordinator=new Worker(new URL('./optimizer-process-worker.js',import.meta.url),{
      workerData:{context:message.context,task:message.task,task_id:taskId,cancellation:cancellation.buffer},execArgv:[],
      resourceLimits:{maxOldGenerationSizeMb:message.coordinator_heap_mib,maxYoungGenerationSizeMb:32},
    });
    coordinator.on('message',value=>{
      if(value?.task_id!==taskId)return;
      if(value.type==='complete'||value.type==='failed')terminal=value;
      else send(value);
    });
    coordinator.on('error',error=>{terminal={type:'failed',task_id:taskId,code:'worker_crash',error:String(error?.message||'Candidate coordinator failed.').slice(0,1000)};});
    coordinator.on('exit',code=>{
      const result=terminal&&(code===0||terminal.type==='failed')?terminal:{type:'failed',task_id:taskId,code:'worker_crash',error:'Candidate coordinator exited without a successful result.'};
      send(result,shutdown);
    });
  }catch(error){
    send({type:'failed',task_id:taskId,code:'worker_start',error:String(error?.message||'Candidate coordinator could not start.').slice(0,1000)},shutdown);
  }
});
send({type:'ready',protocol:1,process_id:process.pid});
