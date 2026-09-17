/** Small, JSON-safe affinity records shared by research coordinators and workers. */
const statuses=new Set(['pending','pinned','failed','automatic','unsupported','unavailable']);
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
export function affinityRecord(value){
  if(!value||typeof value!=='object'||!statuses.has(value.status))return null;
  const record={status:value.status,verified:false};
  if(integer(value.group,65535)&&integer(value.cpu,65535)){record.group=value.group;record.cpu=value.cpu;}
  if(integer(value.core,16777215)||typeof value.core==='string'&&/^[A-Za-z0-9:_-]{1,80}$/.test(value.core))record.core=value.core;
  if(typeof value.reason==='string')record.reason=value.reason.slice(0,400);
  record.verified=record.status==='pinned'&&value.verified===true&&record.group!==undefined;
  if(record.status==='pinned'&&!record.verified){record.status='failed';record.reason='Worker CPU assignment was not verified.';}
  return record;
}
export function workerAffinityRequest(plan,index){
  if(!plan)return null;
  if(plan.status==='planned'){
    const assignment=plan.assignments?.[index];
    if(!assignment||!integer(assignment.group,65535)||!integer(assignment.cpu,65535))throw new Error('Research CPU assignment is missing or invalid');
    return {mode:'pinned',assignment};
  }
  return {mode:'automatic',status:['automatic','unsupported','unavailable'].includes(plan.status)?plan.status:'unavailable',reason:plan.reason};
}
export function pendingAffinity(request){
  return request?.mode==='pinned'?{...request.assignment,status:'pending',verified:false}:request?{status:request.status,verified:false,reason:request.reason}:null;
}
export function confirmedAffinity(request,value){
  const record=affinityRecord(value);
  if(!request)return record;
  if(request.mode==='pinned'){
    if(record?.status==='pinned'&&record.verified&&record.group===request.assignment.group&&record.cpu===request.assignment.cpu)return {...record,core:request.assignment.core};
    return {...request.assignment,status:'failed',verified:false,reason:record?.reason||'Worker did not verify its assigned CPU.'};
  }
  return {status:request.status,verified:false,reason:request.reason};
}
export function workerAffinityRecords(value,limit=100){
  if(!Array.isArray(value))return null;
  const seen=new Set();
  return value.slice(0,Math.min(800,limit*2)).flatMap(item=>{
    if(!item||!Number.isSafeInteger(item.worker_id)||item.worker_id<=0)return [];
    const processId=Number.isSafeInteger(item.process_id)&&item.process_id>0?item.process_id:null;
    const identity=`${processId??''}:${item.worker_id}`;if(seen.has(identity))return [];
    const affinity=affinityRecord(item.affinity);if(!affinity)return [];
    const state=['starting','ready','busy','retiring','stopped'].includes(item.state)?item.state:null;
    seen.add(identity);return [{worker_id:item.worker_id,...(processId?{process_id:processId}:{}),affinity,...(state?{state}:{})}];
  });
}
