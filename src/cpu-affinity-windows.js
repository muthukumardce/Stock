/** Windows affinity is applied only to the calling research Worker thread.
 * CPU-set topology and reservation flags:
 * https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-system_cpu_set_information
 * Group affinity is a hard, single-group restriction, unlike soft CPU sets:
 * https://learn.microsoft.com/windows/win32/api/processtopologyapi/nf-processtopologyapi-setthreadgroupaffinity
 */
import {createRequire} from 'node:module';
import {isMainThread} from 'node:worker_threads';

const require=createRequire(import.meta.url),MAX_CPUS=65536,MAX_BYTES=4*1024*1024,MAX_MASK=(1n<<64n)-1n;
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const validAssignment=value=>value&&integer(value.group,65535)&&integer(value.cpu,63)&&integer(value.core,16777215);
const asMask=value=>{const mask=typeof value==='bigint'?value:typeof value==='number'&&Number.isSafeInteger(value)?BigInt(value):null;if(mask===null||mask<0n||mask>MAX_MASK)throw new Error('Invalid affinity mask');return mask;};
const groupBuffer=value=>{const buffer=Buffer.alloc(16);buffer.writeBigUInt64LE(asMask(value.mask),0);buffer.writeUInt16LE(value.group,8);return buffer;};
const groupFrom=buffer=>({group:buffer.readUInt16LE(8),mask:buffer.readBigUInt64LE(0)});
const unavailable=()=>({mode:'pinned',status:'unavailable',reason:'Windows CPU topology or effective affinity restrictions could not be verified; automatic scheduling will be used.',assignments:[],available_cpus:0,physical_cores:0});

export function decodeWindowsCpuSets(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>MAX_BYTES)throw new Error('Invalid CPU-set buffer');
  const rows=[];
  for(let offset=0;offset<buffer.length;){
    if(buffer.length-offset<8)throw new Error('Truncated CPU-set record');
    const size=buffer.readUInt32LE(offset),type=buffer.readUInt32LE(offset+4);
    if(size<8||size>buffer.length-offset)throw new Error('Invalid CPU-set record size');
    if(type===0){
      if(size<32||rows.length>=MAX_CPUS)throw new Error('Invalid CPU-set topology');
      const flags=buffer[offset+19],group=buffer.readUInt16LE(offset+12),coreIndex=buffer[offset+15];
      rows.push({id:buffer.readUInt32LE(offset+8),group,cpu:buffer[offset+14],core:group*256+coreIndex,
        parked:Boolean(flags&1),allocated:Boolean(flags&2),allocated_to_process:Boolean(flags&4)});
    }
    offset+=size;
  }
  return rows;
}

function nativeBackend(){
  if(!['x64','arm64'].includes(process.arch))throw new Error('64-bit Windows is required');
  const koffi=require('koffi'),kernel=koffi.load('kernel32.dll'),bind=prototype=>kernel.func(prototype);
  const GetCurrentProcess=bind('void * __stdcall GetCurrentProcess()'),GetCurrentThread=bind('void * __stdcall GetCurrentThread()');
  const GetLastError=bind('uint32_t __stdcall GetLastError()');
  const GetSystemCpuSetInformation=bind('int __stdcall GetSystemCpuSetInformation(void *, uint32_t, void *, void *, uint32_t)');
  const GetProcessDefaultCpuSets=bind('int __stdcall GetProcessDefaultCpuSets(void *, void *, uint32_t, void *)');
  const GetThreadSelectedCpuSets=bind('int __stdcall GetThreadSelectedCpuSets(void *, void *, uint32_t, void *)');
  const GetProcessGroupAffinity=bind('int __stdcall GetProcessGroupAffinity(void *, void *, void *)');
  const GetProcessAffinityMask=bind('int __stdcall GetProcessAffinityMask(void *, void *, void *)');
  const GetThreadGroupAffinity=bind('int __stdcall GetThreadGroupAffinity(void *, void *)');
  const SetThreadGroupAffinity=bind('int __stdcall SetThreadGroupAffinity(void *, void *, void *)');
  const GetCurrentProcessorNumberEx=bind('void __stdcall GetCurrentProcessorNumberEx(void *)');
  const IsProcessInJob=bind('int __stdcall IsProcessInJob(void *, void *, void *)');
  const QueryInformationJobObject=bind('int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)');
  const optional=prototype=>{try{return bind(prototype);}catch{return null;}};
  const processMasks=optional('int __stdcall GetProcessDefaultCpuSetMasks(void *, void *, uint16_t, void *)');
  const threadMasks=optional('int __stdcall GetThreadSelectedCpuSetMasks(void *, void *, uint16_t, void *)');
  const check=value=>{if(!value)throw new Error('Windows affinity query failed');};
  function ids(fn,handle){
    const count=Buffer.alloc(4);let output=null,capacity=0;
    for(let attempt=0;attempt<3;attempt++){
      const success=fn(handle,output,capacity,count),needed=count.readUInt32LE();
      if(needed>MAX_CPUS)throw new Error('CPU-set count exceeds limit');
      if(success){if(needed>capacity)throw new Error('Invalid CPU-set result');return needed?Array.from({length:needed},(_,i)=>output.readUInt32LE(i*4)):[];}
      if(GetLastError()!==122||!needed)throw new Error('Cannot query CPU sets');
      output=Buffer.alloc(needed*4);capacity=needed;
    }
    throw new Error('CPU sets changed repeatedly');
  }
  function masks(fn,handle){
    if(!fn)return null;const count=Buffer.alloc(2),buffer=Buffer.alloc(65535*16);
    check(fn(handle,buffer,65535,count));const length=count.readUInt16LE();
    return Array.from({length},(_,i)=>groupFrom(buffer.subarray(i*16,i*16+16)));
  }
  function getThreadAffinity(){const output=Buffer.alloc(16);check(GetThreadGroupAffinity(GetCurrentThread(),output));return groupFrom(output);}
  function snapshot(){
    const processHandle=GetCurrentProcess(),thread=GetCurrentThread(),length=Buffer.alloc(4);let bytes=null;
    for(let attempt=0;attempt<3;attempt++){
      const success=GetSystemCpuSetInformation(bytes,bytes?.length||0,length,processHandle,0),needed=length.readUInt32LE();
      if(!needed||needed>MAX_BYTES)throw new Error('CPU topology exceeds limit');
      if(success){if(needed>bytes.length)throw new Error('Invalid CPU topology result');bytes=bytes.subarray(0,needed);break;}
      if(GetLastError()!==122)throw new Error('Cannot query CPU topology');bytes=Buffer.alloc(needed);
      if(attempt===2)throw new Error('CPU topology changed repeatedly');
    }
    const groups=Buffer.alloc(65535*2),count=Buffer.alloc(2);count.writeUInt16LE(65535);check(GetProcessGroupAffinity(processHandle,count,groups));
    const processMask=Buffer.alloc(8),systemMask=Buffer.alloc(8);check(GetProcessAffinityMask(processHandle,processMask,systemMask));
    const affinity=getThreadAffinity(),inJob=Buffer.alloc(4);check(IsProcessInJob(processHandle,null,inJob));let jobMasks=null;
    if(inJob.readInt32LE()){
      const output=Buffer.alloc(65535*16),returned=Buffer.alloc(4);check(QueryInformationJobObject(null,14,output,output.length,returned));
      const used=returned.readUInt32LE();if(used>output.length||used%16)throw new Error('Invalid job affinity');
      jobMasks=Array.from({length:used/16},(_,i)=>groupFrom(output.subarray(i*16,i*16+16)));
    }
    return {cpus:decodeWindowsCpuSets(bytes),groups:Array.from({length:count.readUInt16LE()},(_,i)=>groups.readUInt16LE(i*2)),
      thread_affinity:affinity,process_mask:processMask.readBigUInt64LE(),system_mask:systemMask.readBigUInt64LE(),
      process_cpu_sets:ids(GetProcessDefaultCpuSets,processHandle),thread_cpu_sets:ids(GetThreadSelectedCpuSets,thread),
      process_cpu_masks:masks(processMasks,processHandle),thread_cpu_masks:masks(threadMasks,thread),job_masks:jobMasks};
  }
  return {snapshot,getThreadAffinity,
    setThreadAffinity:affinity=>Boolean(SetThreadGroupAffinity(GetCurrentThread(),groupBuffer(affinity),null)),
    getCurrentProcessor:()=>{const value=Buffer.alloc(4);GetCurrentProcessorNumberEx(value);return {group:value.readUInt16LE(),cpu:value[2]};},
  };
}

function eligible(snapshot){
  if(!snapshot||!Array.isArray(snapshot.cpus)||!snapshot.cpus.length||snapshot.cpus.length>MAX_CPUS||!Array.isArray(snapshot.groups)||!snapshot.groups.length)throw new Error('No verified CPU topology');
  const groups=new Set(snapshot.groups);if([...groups].some(group=>!integer(group,65535)))throw new Error('Invalid process groups');
  const current=snapshot.thread_affinity;if(!current||!integer(current.group,65535)||!groups.has(current.group))throw new Error('Invalid current thread affinity');
  let processMask=asMask(snapshot.process_mask),systemMask=asMask(snapshot.system_mask);const threadMask=asMask(current.mask);
  // GetCurrentProcess() normally makes GetProcessAffinityMask report the calling
  // thread's primary group, including after other workers move between groups.
  // Older multi-group behavior can instead report two zero masks. In that case
  // only the existing thread's group/mask is proven: never widen it to a sibling
  // group, and continue intersecting CPU sets, job restrictions and reservations.
  // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-getprocessaffinitymask
  const groupOnlyFallback=processMask===0n&&systemMask===0n&&groups.size>1;
  if(groupOnlyFallback){
    systemMask=snapshot.cpus.filter(row=>row.group===current.group).reduce((mask,row)=>{
      if(!validAssignment(row))throw new Error('Invalid primary-group topology');return mask|(1n<<BigInt(row.cpu));
    },0n);
    processMask=threadMask;
  }
  if(!processMask||!systemMask||!threadMask||(processMask&systemMask)!==processMask||(threadMask&processMask)!==threadMask)throw new Error('Unverified process affinity');
  // A restricted primary-group mask must never be widened by moving the worker
  // into another group. Full masks permit the other verified process groups.
  const primaryOnly=groupOnlyFallback||processMask!==systemMask||threadMask!==systemMask;
  const ids=value=>{if(!Array.isArray(value)||value.some(id=>!integer(id,0xffffffff)))throw new Error('Invalid CPU sets');return new Set(value);};
  const processSets=ids(snapshot.process_cpu_sets),threadSets=ids(snapshot.thread_cpu_sets);
  const masks=value=>{
    if(value===null||value===undefined)return null;if(!Array.isArray(value))throw new Error('Invalid CPU-set masks');
    const result=new Map();for(const mask of value){if(!mask||!integer(mask.group,65535))throw new Error('Invalid CPU group mask');result.set(mask.group,(result.get(mask.group)||0n)|asMask(mask.mask));}return result.size?result:null;
  };
  const restrictions=[snapshot.process_cpu_masks,snapshot.thread_cpu_masks,snapshot.job_masks].map(masks),seen=new Set(),seenIds=new Set();
  const rows=snapshot.cpus.filter(row=>{
    if(!validAssignment(row)||!integer(row.id,0xffffffff)||seen.has(`${row.group}:${row.cpu}`)||seenIds.has(row.id))throw new Error('Ambiguous CPU topology');
    seen.add(`${row.group}:${row.cpu}`);seenIds.add(row.id);
    const bit=1n<<BigInt(row.cpu);
    return groups.has(row.group)&&(!primaryOnly||row.group===current.group)&&(!row.parked)&&(!row.allocated||row.allocated_to_process)
      &&(row.group!==current.group||Boolean(bit&processMask&threadMask))
      &&(!processSets.size||processSets.has(row.id))&&(!threadSets.size||threadSets.has(row.id))
      &&restrictions.every(mask=>!mask||Boolean((mask.get(row.group)||0n)&bit));
  }).sort((a,b)=>a.group-b.group||a.core-b.core||a.cpu-b.cpu);
  const cores=new Map();for(const row of rows){if(!cores.has(row.core))cores.set(row.core,[]);cores.get(row.core).push(row);}
  const ordered=[];for(let sibling=0;;sibling++){
    let added=false;for(const siblings of cores.values())if(siblings[sibling]){ordered.push(siblings[sibling]);added=true;}if(!added)break;
  }
  return {rows:ordered,physical_cores:cores.size};
}

export function createWindowsAffinityAdapter({backend,backendFactory=nativeBackend,isWorker=()=>!isMainThread}={}){
  let loaded=backend;const native=()=>loaded??=(backendFactory());
  return {
    planWindowsAffinity({workerLimit=1}={}){
      if(!Number.isInteger(workerLimit)||workerLimit<1||workerLimit>400)throw new RangeError('Affinity worker limit must be between 1 and 400');
      try{
        const {rows,physical_cores}=eligible(native().snapshot());if(!rows.length)return unavailable();
        return {mode:'pinned',status:'planned',reason:'Distinct allowed Windows logical CPUs are assigned, using separate physical cores before SMT siblings.',
          assignments:rows.slice(0,workerLimit).map(({group,cpu,core})=>({group,cpu,core})),available_cpus:rows.length,physical_cores};
      }catch{return unavailable();}
    },
    applyWindowsAffinity(assignment){
      const base={status:'failed',group:validAssignment(assignment)?assignment.group:null,cpu:validAssignment(assignment)?assignment.cpu:null,core:validAssignment(assignment)?assignment.core:null,verified:false};
      if(!isWorker())return {...base,reason:'CPU affinity can only be applied inside a research Worker thread.'};
      if(!validAssignment(assignment))return {...base,reason:'The requested Windows CPU assignment is invalid.'};
      let api,previous,changed=false;
      try{
        api=native();const {rows}=eligible(api.snapshot());
        if(!rows.some(row=>row.group===assignment.group&&row.cpu===assignment.cpu&&row.core===assignment.core))return {...base,reason:'The requested CPU is no longer in this worker’s allowed processor set.'};
        previous=api.getThreadAffinity();if(!previous||!integer(previous.group,65535)||!asMask(previous.mask))throw new Error('Cannot preserve affinity');
        const mask=1n<<BigInt(assignment.cpu);
        changed=true;
        if(!api.setThreadAffinity({group:assignment.group,mask}))throw new Error('Windows refused the worker CPU assignment');
        const current=api.getThreadAffinity(),processor=api.getCurrentProcessor();
        if(current.group!==assignment.group||asMask(current.mask)!==mask||processor.group!==assignment.group||processor.cpu!==assignment.cpu)throw new Error('Affinity verification failed');
        return {...base,status:'pinned',verified:true,reason:'The worker affinity mask and its current processor both match the assigned CPU.'};
      }catch{
        let restored=false;if(changed&&previous)try{
          if(api.setThreadAffinity(previous)){const actual=api.getThreadAffinity();restored=actual.group===previous.group&&asMask(actual.mask)===asMask(previous.mask);}
        }catch{}
        return {...base,reason:changed?(restored?'CPU verification failed; the previous thread group affinity was restored. This worker must be retired.':'CPU verification failed and the previous thread affinity could not be restored. This worker must be retired.'):'Windows CPU affinity could not be verified. This worker must be retired.'};
      }
    },
  };
}

const adapter=createWindowsAffinityAdapter();
export const planWindowsAffinity=options=>adapter.planWindowsAffinity(options);
export const applyWindowsAffinity=assignment=>adapter.applyWindowsAffinity(assignment);
