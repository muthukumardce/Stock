/** Linux worker affinity, scoped to the calling thread and its existing CPU set.
 * https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html
 * https://www.kernel.org/doc/html/latest/admin-guide/cputopology.html
 * https://koffi.dev/load and https://koffi.dev/output
 */
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {endianness} from 'node:os';
import {isMainThread} from 'node:worker_threads';

const require=createRequire(import.meta.url),MAX_CPUS=65536,MAX_MASK_BYTES=MAX_CPUS/8,MAX_WORKERS=400;
const ROOT='/sys/devices/system/cpu';
const integer=value=>Number.isSafeInteger(value)&&value>=0&&value<MAX_CPUS;
const unavailable=reason=>({mode:'pinned',status:'unavailable',reason,assignments:[]});
const problem=reason=>Object.assign(new Error(reason),{affinityReason:reason});

function nativeBackend(){
  // Bind primitive signatures per worker isolate. Never use Koffi's .async:
  // that would change a libuv thread's affinity instead of this Node worker.
  const koffi=require('koffi');let lib;
  for(const name of ['libc.so.6','libc.so']){try{lib=koffi.load(name);break;}catch{}}
  if(!lib)throw problem('Linux native affinity functions are unavailable.');
  return {
    wordBytes:koffi.sizeof('unsigned long'),endian:endianness(),
    getAffinity:lib.func('int sched_getaffinity(int pid, size_t size, _Out_ void *mask)'),
    setAffinity:lib.func('int sched_setaffinity(int pid, size_t size, const void *mask)'),
    getCpu:lib.func('int sched_getcpu(void)'),errno:()=>koffi.errno(),invalidArgument:koffi.os.errno.EINVAL,
  };
}

function cpuList(text){
  if(typeof text!=='string'||text.length>MAX_CPUS*6||!text.trim())throw problem('Linux online CPU information is unavailable.');
  const cpus=new Set();let parsed=0;
  for(const part of text.trim().split(',')){
    const match=/^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if(!match)throw problem('Linux online CPU information is invalid.');
    const start=Number(match[1]),end=Number(match[2]??match[1]);
    if(!integer(start)||!integer(end)||end<start||(parsed+=end-start+1)>MAX_CPUS)throw problem('Linux online CPU information exceeds supported bounds.');
    for(let cpu=start;cpu<=end;cpu++)cpus.add(cpu);
  }
  return cpus;
}

function layout(backend){
  if(![4,8].includes(backend.wordBytes)||!['LE','BE'].includes(backend.endian))throw problem('Linux CPU mask layout is unsupported.');
  return {wordBytes:backend.wordBytes,endian:backend.endian};
}
function byteFor(cpu,{wordBytes,endian}){
  const word=Math.floor(cpu/(wordBytes*8)),byte=Math.floor(cpu/8)%wordBytes;
  return word*wordBytes+(endian==='LE'?byte:wordBytes-1-byte);
}
const contains=(mask,cpu,format)=>Boolean(mask[byteFor(cpu,format)]&(1<<(cpu%8)));
function affinityMask(backend){
  for(let size=128;size<=MAX_MASK_BYTES;size*=2){
    const mask=Buffer.alloc(size),result=backend.getAffinity(0,size,mask);
    if(result===0){if(!mask.some(value=>value!==0))throw problem('Linux current-thread CPU allowance is empty.');return mask;}
    if(result!==-1||backend.errno()!==backend.invalidArgument)throw problem('Linux current-thread CPU allowance could not be read.');
  }
  throw problem('Linux CPU allowance exceeds the supported mask size.');
}
function topologyId(text){
  if(typeof text!=='string'||text.length>16||!/^\d{1,5}\s*$/.test(text))throw problem('Linux physical CPU topology could not be verified.');
  const value=Number(text);if(!integer(value))throw problem('Linux physical CPU topology exceeds supported bounds.');return value;
}

/** Injectable syscall/sysfs fixtures keep tests independent of the host OS. */
export function createLinuxAffinityAdapter({platform=process.platform,backend,loadBackend=nativeBackend,readFile=readFileSync,mainThread=isMainThread}={}){
  let native=backend;
  const binding=()=>native??=loadBackend();
  const online=()=>cpuList(readFile(ROOT+'/online','utf8'));
  function plan({workerLimit=1}={}){
    if(!Number.isInteger(workerLimit)||workerLimit<1||workerLimit>MAX_WORKERS)return unavailable('Linux worker count must be between 1 and 400.');
    if(platform!=='linux')return unavailable('Linux CPU affinity is unavailable on this platform.');
    try{
      const api=binding(),format=layout(api),mask=affinityMask(api),groups=new Map();
      for(const cpu of [...online()].sort((a,b)=>a-b)){
        if(!contains(mask,cpu,format))continue;
        const packageId=topologyId(readFile(`${ROOT}/cpu${cpu}/topology/physical_package_id`,'utf8'));
        const coreId=topologyId(readFile(`${ROOT}/cpu${cpu}/topology/core_id`,'utf8'));
        const key=packageId+':'+coreId;
        if(!groups.has(key))groups.set(key,{packageId,coreId,cpus:[]});
        groups.get(key).cpus.push(cpu);
      }
      const physical=[...groups.values()].sort((a,b)=>a.packageId-b.packageId||a.coreId-b.coreId);
      if(!physical.length)return unavailable('No online CPUs remain within the calling thread allowance.');
      const first=[],siblings=[];
      physical.forEach((item,core)=>item.cpus.forEach((cpu,index)=>(index?siblings:first).push({group:0,cpu,core})));
      return {mode:'pinned',status:'planned',reason:'Allowed online physical cores are assigned before their SMT siblings.',
        available_cpus:first.length+siblings.length,physical_cores:physical.length,assignments:[...first,...siblings].slice(0,workerLimit)};
    }catch(error){return unavailable(error?.affinityReason||'Linux affinity or physical CPU topology could not be verified.');}
  }
  function apply(assignment){
    const valid=assignment&&assignment.group===0&&integer(assignment.cpu)&&integer(assignment.core);
    const result={status:'failed',group:0,cpu:valid?assignment.cpu:null,core:valid?assignment.core:null,verified:false,reason:''};
    if(!valid)return {...result,reason:'Invalid Linux worker CPU assignment.'};
    if(platform!=='linux')return {...result,reason:'Linux CPU affinity is unavailable on this platform.'};
    if(mainThread)return {...result,reason:'CPU affinity can only be applied inside an analytics worker.'};
    let api,original,attempted=false;
    try{
      api=binding();const format=layout(api);original=affinityMask(api);
      if(!contains(original,assignment.cpu,format)||!online().has(assignment.cpu))throw problem('Assigned CPU is outside the worker current online allowance.');
      const target=Buffer.alloc(original.length);target[byteFor(assignment.cpu,format)]=1<<(assignment.cpu%8);
      attempted=true;
      if(api.setAffinity(0,target.length,target)!==0)throw problem('Linux could not apply the worker CPU assignment.');
      const observed=affinityMask(api);
      if(!observed.equals(target)||api.getCpu()!==assignment.cpu)throw problem('Linux worker CPU assignment could not be verified.');
      return {...result,status:'pinned',verified:true,reason:'Worker CPU mask and executing CPU were verified.'};
    }catch(error){
      let reason=error?.affinityReason||'Linux worker affinity is unavailable.';
      if(attempted){
        let restored=false;
        try{restored=api.setAffinity(0,original.length,original)===0&&affinityMask(api).equals(original);}catch{}
        reason+=restored?' Previous worker CPU allowance was restored.':' Previous worker CPU allowance could not be fully restored.';
      }
      return {...result,reason};
    }
  }
  return {planLinuxAffinity:plan,applyLinuxAffinity:apply};
}

const defaultAdapter=createLinuxAffinityAdapter();
export const planLinuxAffinity=options=>defaultAdapter.planLinuxAffinity(options);
export const applyLinuxAffinity=assignment=>defaultAdapter.applyLinuxAffinity(assignment);
