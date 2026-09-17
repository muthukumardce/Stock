import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinuxAffinityAdapter,planLinuxAffinity,applyLinuxAffinity} from '../src/cpu-affinity-linux.js';

function mask(cpus,size=128,wordBytes=8,endian='LE'){
  const value=Buffer.alloc(size);
  for(const cpu of cpus){const word=Math.floor(cpu/(wordBytes*8)),byte=Math.floor(cpu/8)%wordBytes;value[word*wordBytes+(endian==='LE'?byte:wordBytes-1-byte)]|=1<<(cpu%8);}
  return value;
}
function fixture({allowed=[0,1,2,3],online='0-3',topology={0:[0,0],1:[0,0],2:[0,1],3:[0,1]},wordBytes=8,endian='LE',minimumBytes=128,mainThread=false}={}){
  let current=mask(allowed,minimumBytes,wordBytes,endian),errno=0;const calls={get:[],set:[],reads:[]};
  const backend={wordBytes,endian,invalidArgument:22,errno:()=>errno,
    getAffinity(pid,size,output){calls.get.push({pid,size});if(size<minimumBytes){errno=22;return -1;}current.copy(output);return 0;},
    setAffinity(pid,size,input){calls.set.push({pid,size,mask:Buffer.from(input)});current=Buffer.from(input);return 0;},
    getCpu(){for(let cpu=0;cpu<current.length*8;cpu++)if(mask([cpu],current.length,wordBytes,endian).every((value,index)=>(value&current[index])===value))return cpu;return -1;},
  };
  const readFile=(path,encoding)=>{
    calls.reads.push(path);assert.equal(encoding,'utf8');if(path.endsWith('/online'))return online;
    const match=/\/cpu(\d+)\/topology\/(physical_package_id|core_id)$/.exec(path);assert.ok(match);
    const tuple=topology[Number(match[1])];if(!tuple)throw new Error('fixture topology unavailable');
    return String(tuple[match[2]==='core_id'?1:0])+'\n';
  };
  return {backend,calls,readFile,getCurrent:()=>Buffer.from(current),setCurrent:value=>{current=Buffer.from(value);},
    adapter:createLinuxAffinityAdapter({platform:'linux',backend,readFile,mainThread})};
}

test('Linux planner intersects effective affinity and online CPUs, then assigns physical cores before SMT',()=>{
  const f=fixture({allowed:[1,2,3,4,5,6,7],online:'0-5,7',topology:{1:[0,0],2:[0,1],3:[0,1],4:[1,0],5:[1,0],7:[1,1]}});
  const plan=f.adapter.planLinuxAffinity({workerLimit:100});
  assert.equal(plan.status,'planned');assert.equal(plan.mode,'pinned');
  assert.equal(plan.available_cpus,6);assert.equal(plan.physical_cores,4);
  assert.deepEqual(plan.assignments,[{group:0,cpu:1,core:0},{group:0,cpu:2,core:1},{group:0,cpu:4,core:2},{group:0,cpu:7,core:3},{group:0,cpu:3,core:1},{group:0,cpu:5,core:2}]);
  assert.equal(f.calls.set.length,0);assert.ok(f.calls.get.every(call=>call.pid===0));
  assert.ok(!f.calls.reads.some(path=>/\/cpu[06]\//.test(path)));
  const small=f.adapter.planLinuxAffinity({workerLimit:2});
  assert.deepEqual(small.assignments,plan.assignments.slice(0,2));assert.equal(small.available_cpus,6);assert.equal(small.physical_cores,4);
});

test('Linux masks span high CPU indexes and grow only for the documented small-buffer error',()=>{
  const f=fixture({allowed:[63,64,1024,4095],online:'63-64,1024,4095',minimumBytes:512,topology:{63:[0,0],64:[0,1],1024:[1,0],4095:[1,1]}});
  assert.deepEqual(f.adapter.planLinuxAffinity({workerLimit:4}).assignments.map(value=>value.cpu),[63,64,1024,4095]);
  assert.deepEqual(f.calls.get.map(call=>call.size),[128,256,512]);
  f.backend.getAffinity=()=>-1;f.backend.errno=()=>1;
  assert.equal(f.adapter.planLinuxAffinity({workerLimit:4}).status,'unavailable');
});

for(const wordBytes of [4,8])for(const endian of ['LE','BE'])test(`Linux ${wordBytes*8}-bit ${endian} CPU masks preserve word and bit boundaries`,()=>{
  const cpus=[0,7,8,31,32,63,64,95],topology=Object.fromEntries(cpus.map((cpu,index)=>[cpu,[0,index]]));
  const f=fixture({allowed:cpus,online:cpus.join(','),topology,wordBytes,endian});
  const plan=f.adapter.planLinuxAffinity({workerLimit:8});assert.deepEqual(plan.assignments.map(value=>value.cpu),cpus);
  const pinned=f.adapter.applyLinuxAffinity(plan.assignments.at(-1));assert.equal(pinned.status,'pinned');assert.equal(pinned.verified,true);
  assert.deepEqual(f.getCurrent(),mask([95],128,wordBytes,endian));assert.equal(f.calls.set[0].pid,0);
});

test('Linux pinning narrows only the current worker allowance and verifies the running CPU',()=>{
  const f=fixture(),result=f.adapter.applyLinuxAffinity({group:0,cpu:2,core:1});
  assert.deepEqual(result,{status:'pinned',group:0,cpu:2,core:1,verified:true,reason:'Worker CPU mask and executing CPU were verified.'});
  assert.deepEqual(f.calls.set,[{pid:0,size:128,mask:mask([2])}]);
  assert.ok(f.calls.get.every(call=>call.pid===0));
});

test('Linux pinning rejects stale, offline, malformed and outside-allowance assignments without changing affinity',()=>{
  const f=fixture({allowed:[1,2],online:'0-1'});
  for(const value of [{group:0,cpu:0,core:0},{group:0,cpu:2,core:0},{group:1,cpu:1,core:0},{group:0,cpu:65536,core:0},{group:0,cpu:1,core:-1},null]){
    const result=f.adapter.applyLinuxAffinity(value);assert.equal(result.status,'failed');assert.equal(result.verified,false);
  }
  assert.equal(f.calls.set.length,0);
});

test('a Linux pin verification mismatch restores the prior allowance before failure',()=>{
  for(const mismatch of ['mask','cpu','get_error']){
    const f=fixture(),original=f.getCurrent(),set=f.backend.setAffinity;let changed=false;
    f.backend.setAffinity=(pid,size,value)=>{const result=set(pid,size,value);if(!changed){changed=true;if(mismatch==='mask')f.setCurrent(mask([1,2]));}return result;};
    if(mismatch==='cpu')f.backend.getCpu=()=>3;
    if(mismatch==='get_error'){const get=f.backend.getAffinity;let reads=0;f.backend.getAffinity=(...args)=>{if(++reads===2)throw new Error('native detail');return get(...args);};}
    const result=f.adapter.applyLinuxAffinity({group:0,cpu:2,core:1});
    assert.equal(result.status,'failed');assert.equal(result.verified,false);assert.match(result.reason,/was restored/);
    assert.deepEqual(f.getCurrent(),original);assert.equal(f.calls.set.length,2);assert.ok(!result.reason.includes('native detail'));
  }
});

test('failed Linux set calls attempt restoration and honestly report a failed restore',()=>{
  for(const canRestore of [true,false]){
    const f=fixture(),set=f.backend.setAffinity;let attempts=0;
    f.backend.setAffinity=(...args)=>{if(++attempts===1)return -1;return canRestore?set(...args):-1;};
    const result=f.adapter.applyLinuxAffinity({group:0,cpu:2,core:1});
    assert.equal(attempts,2);assert.equal(result.status,'failed');
    assert.match(result.reason,canRestore?/was restored/:/could not be fully restored/);
  }
});

test('unsupported platforms and main-thread apply never load or call native setters',()=>{
  let loads=0;const adapter=createLinuxAffinityAdapter({platform:'darwin',loadBackend:()=>{loads++;throw new Error('should not load');}});
  assert.equal(adapter.planLinuxAffinity({workerLimit:2}).status,'unavailable');assert.equal(adapter.applyLinuxAffinity({group:0,cpu:0,core:0}).status,'failed');assert.equal(loads,0);
  const f=fixture({mainThread:true});assert.equal(f.adapter.applyLinuxAffinity({group:0,cpu:1,core:0}).status,'failed');assert.equal(f.calls.set.length,0);assert.equal(f.calls.get.length,0);
  assert.equal(applyLinuxAffinity({group:0,cpu:0,core:0}).status,'failed');
  if(process.platform!=='linux')assert.equal(planLinuxAffinity({workerLimit:1}).status,'unavailable');
});

test('Linux topology and worker-limit parsing fail safely within bounded resources',()=>{
  for(const online of ['', '0-65536','1-0','1, 2','0-2:3','a','0,'.repeat(200000),'0-65535,0-65535']){
    const f=fixture({online});assert.equal(f.adapter.planLinuxAffinity({workerLimit:2}).status,'unavailable');assert.equal(f.calls.set.length,0);
  }
  for(const limit of [0,-1,401,1.5,Infinity,'2'])assert.equal(fixture().adapter.planLinuxAffinity({workerLimit:limit}).status,'unavailable');
  const missing=fixture({topology:{0:[-1,0]}});assert.equal(missing.adapter.planLinuxAffinity({workerLimit:2}).status,'unavailable');
  const huge=fixture();let attempts=0;huge.backend.getAffinity=()=>{attempts++;return -1;};huge.backend.errno=()=>22;
  assert.equal(huge.adapter.planLinuxAffinity({workerLimit:2}).status,'unavailable');assert.equal(attempts,7);
  const native=createLinuxAffinityAdapter({platform:'linux',loadBackend:()=>{throw new Error('sensitive native path');}});
  assert.equal(native.planLinuxAffinity({workerLimit:2}).status,'unavailable');assert.ok(!native.planLinuxAffinity({workerLimit:2}).reason.includes('sensitive'));
});
