import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapacityDetector} from '../src/capacity.js';

const system=(platform='win32',hardware=64,available=64)=>({platform:()=>platform,cpus:()=>Array(hardware).fill({}),availableParallelism:()=>available});
const observed=(changes={})=>({logical_cpus:192,physical_cpus:96,build:26200,product_type:1,primary_group_affinity_cpus:64,...changes});
const response=value=>({status:0,stdout:JSON.stringify(value)});

test('verified modern Windows expands a capped runtime estimate and preserves both machine and runtime counts',()=>{
  let calls=0;
  const detect=createCapacityDetector({os:system(),spawnSync:(command,args,options)=>{
    calls++;assert.equal(command,'powershell.exe');assert.deepEqual(args.slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-Command']);
    assert.match(args[4],/Get-CimInstance -ClassName Win32_Processor/);assert.match(args[4],/Get-Process -Id \$capacitySelf.ParentProcessId/);
    assert.equal(options.timeout,3000);assert.equal(options.maxBuffer,16384);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
    return response(observed());
  }});
  const result=detect();assert.equal(result.logical_cpus,192);assert.equal(result.available_cpus,192);assert.equal(result.physical_cpus,96);
  assert.equal(result.runtime_cpus,64);assert.equal(result.runtime_available_cpus,64);assert.equal(result.source,'windows_cim_all_groups_estimate');
  assert.match(result.scope,/not a utilization guarantee/);assert.match(result.scope,/CPU-set\/job/);
  assert.equal(detect(),result);assert.equal(calls,1);assert.ok(Object.isFrozen(result));
});

test('Server 2022 is eligible while older server and workstation builds retain runtime capacity',()=>{
  for(const [build,product_type,expected] of [[20348,3,192],[20348,2,192],[20347,3,64],[21999,1,64],[22000,1,192],[19045,1,64]]){
    const value=createCapacityDetector({os:system(),spawnSync:()=>response(observed({build,product_type}))})();
    assert.equal(value.logical_cpus,192);assert.equal(value.available_cpus,expected,`${build}/${product_type}`);
  }
});

test('known runtime and primary-group restrictions prevent widening usable CPU capacity',()=>{
  const limited=createCapacityDetector({os:system('win32',64,8),spawnSync:()=>response(observed({primary_group_affinity_cpus:8}))})();
  assert.equal(limited.logical_cpus,192);assert.equal(limited.available_cpus,8);assert.equal(limited.source,'windows_cim_runtime_restricted');
  const maskOnly=createCapacityDetector({os:system(),spawnSync:()=>response(observed({primary_group_affinity_cpus:16}))})();
  assert.equal(maskOnly.available_cpus,16);assert.equal(maskOnly.source,'windows_cim_runtime_restricted');
  const unknown=createCapacityDetector({os:system(),spawnSync:()=>response(observed({primary_group_affinity_cpus:null}))})();
  assert.equal(unknown.logical_cpus,192);assert.equal(unknown.available_cpus,64);assert.match(unknown.scope,/could not be verified/);
});

test('Windows timeout, subprocess failure and malformed observations fall back safely and are cached',()=>{
  const invalid=[{error:{code:'ETIMEDOUT'},status:null,stdout:'private diagnostic'}, {status:1,stdout:'192'},
    {status:0,stdout:'not JSON'},response(observed({logical_cpus:0})),response(observed({logical_cpus:-1})),response(observed({logical_cpus:192.5})),
    response(observed({logical_cpus:'192'})),response(observed({logical_cpus:65537})),response(observed({logical_cpus:32})),
    response(observed({build:NaN})),response(observed({product_type:7})),{status:0,stdout:' '.repeat(16385)}];
  for(const value of invalid){let calls=0;const detect=createCapacityDetector({os:system(),spawnSync:()=>{calls++;return value;}}),result=detect();
    assert.equal(result.logical_cpus,64);assert.equal(result.available_cpus,64);assert.equal(result.source,'windows_runtime_fallback');
    assert.equal(JSON.stringify(result).includes('private diagnostic'),false);detect();assert.equal(calls,1);
  }
  assert.equal(createCapacityDetector({os:system(),spawnSync:()=>{throw new Error('unavailable');}})().available_cpus,64);
});

test('Linux and macOS use runtime usable parallelism rather than machine hardware counts',()=>{
  for(const platform of ['linux','darwin']){
    const result=createCapacityDetector({os:system(platform,192,6),spawnSync:()=>{throw new Error('Must not invoke PowerShell');}})();
    assert.equal(result.logical_cpus,192);assert.equal(result.available_cpus,6);assert.equal(result.source,'runtime_available_parallelism');
    assert.match(result.scope,/affinity and container restrictions/);
  }
});

test('missing or invalid runtime metadata still yields a bounded positive fallback',()=>{
  const empty=createCapacityDetector({os:{platform:()=> 'linux',cpus:()=>[],availableParallelism:()=>4}})();
  assert.equal(empty.logical_cpus,4);assert.equal(empty.available_cpus,4);
  const absent=createCapacityDetector({os:{platform:()=> 'linux',cpus:()=>{throw new Error();},availableParallelism:()=>NaN}})();
  assert.equal(absent.logical_cpus,1);assert.equal(absent.available_cpus,1);
});

function linuxFiles({allowed='0-7',online='0-7',topology=Object.fromEntries(Array.from({length:8},(_,cpu)=>[cpu,[0,Math.floor(cpu/2)]])),threadStatus=true}={}){
  const calls=[];
  return {calls,readFileSync:(path,encoding)=>{
    calls.push(path);assert.equal(encoding,'utf8');
    if(path==='/proc/thread-self/status'){if(!threadStatus)throw new Error('Old kernel');return `Name:\tnode\nCpus_allowed_list:\t${allowed}\nMems_allowed_list:\t0\n`;}
    if(path==='/proc/self/status')return `Cpus_allowed_list:\t${allowed}\n`;
    if(path==='/sys/devices/system/cpu/online')return online+'\n';
    const match=/\/cpu(\d+)\/topology\/(physical_package_id|core_id)$/.exec(path);assert.ok(match);
    const tuple=topology[Number(match[1])];if(!tuple)throw new Error('Unavailable topology');
    return String(tuple[match[2]==='physical_package_id'?0:1])+'\n';
  }};
}

test('Linux counts allowed online physical cores across sockets without guessing an SMT ratio',()=>{
  const files=linuxFiles({allowed:'1-7',online:'0-5,7',topology:{1:[0,0],2:[0,1],3:[0,1],4:[1,0],5:[1,0],7:[1,1]}});
  const detect=createCapacityDetector({os:system('linux',8,6),spawnSync:()=>assert.fail('Linux CPU detection needs no subprocess'),readFileSync:files.readFileSync});
  const value=detect();assert.equal(value.physical_cpus,4);assert.equal(value.available_cpus,6);assert.equal(value.logical_cpus,8);
  assert.equal(value.physical_source,'linux_sysfs_thread_allowed');assert.match(value.physical_scope,/No SMT ratio/);
  assert.ok(!files.calls.some(path=>/\/cpu[06]\//.test(path)));
  const reads=files.calls.length;assert.equal(detect(),value);assert.equal(files.calls.length,reads);assert.ok(Object.isFrozen(value));
});

test('Linux honors a sibling-only cpuset and runtime quota cap on distinct cores',()=>{
  const siblings=linuxFiles({allowed:'2-3'});
  const one=createCapacityDetector({os:system('linux',8,2),readFileSync:siblings.readFileSync})();
  assert.equal(one.physical_cpus,1);assert.equal(one.available_cpus,2);
  const quota=linuxFiles(),limited=createCapacityDetector({os:system('linux',8,2),readFileSync:quota.readFileSync})();
  assert.equal(limited.physical_cpus,2);assert.equal(limited.available_cpus,2);
  const noSmt=linuxFiles({topology:Object.fromEntries(Array.from({length:8},(_,cpu)=>[cpu,[0,cpu]]))});
  assert.equal(createCapacityDetector({os:system('linux',8,8),readFileSync:noSmt.readFileSync})().physical_cpus,8);
});

test('Linux fallback process mask is explicit and malformed or missing topology remains unknown',()=>{
  const old=linuxFiles({threadStatus:false});
  const result=createCapacityDetector({os:system('linux',8,8),readFileSync:old.readFileSync})();
  assert.equal(result.physical_cpus,4);assert.equal(result.physical_source,'linux_sysfs_process_allowed');assert.match(result.physical_scope,/estimate/);
  for(const files of [linuxFiles({allowed:'0-65535,0-65535'}),linuxFiles({allowed:'3-1'}),linuxFiles({allowed:'0-65536'}),linuxFiles({allowed:'2;invalid'}),
    linuxFiles({allowed:'0',online:'1'}),linuxFiles({topology:{0:[-1,0]}}),linuxFiles({topology:{0:[0,'NaN']}})]){
    const value=createCapacityDetector({os:system('linux',8,8),readFileSync:files.readFileSync})();
    assert.equal(value.physical_cpus,null);assert.equal(value.physical_source,'unavailable');assert.equal(value.available_cpus,8);
  }
  for(const read of [()=>{throw new Error('private filesystem diagnostic');},()=> 'x'.repeat(1024*1024+1),()=> 'Cpus_allowed_list: 0\nCpus_allowed_list: 1\n']){
    const value=createCapacityDetector({os:system('linux',8,8),readFileSync:read})();
    assert.equal(value.physical_cpus,null);assert.match(value.physical_scope,/eligible logical CPU count/);assert.ok(!JSON.stringify(value).includes('private filesystem'));
  }
});

test('macOS reads enabled physical cores using one fixed bounded sysctl and preserves runtime restrictions',()=>{
  for(const [hardware,available,physical,expected] of [[12,12,12,12],[16,16,8,8],[24,6,12,6]]){
    let calls=0;
    const detect=createCapacityDetector({os:system('darwin',hardware,available),readFileSync:()=>assert.fail('macOS should not read Linux topology'),spawnSync:(command,args,options)=>{
      calls++;assert.equal(command,'/usr/sbin/sysctl');assert.deepEqual(args,['-n','hw.physicalcpu']);assert.equal(options.timeout,1000);assert.equal(options.maxBuffer,1024);assert.equal(options.shell,false);
      assert.deepEqual(options.stdio,['ignore','pipe','ignore']);return {status:0,stdout:String(physical)+'\n'};
    }}),value=detect();
    assert.equal(value.physical_cpus,expected);assert.equal(value.available_cpus,available);assert.equal(value.logical_cpus,hardware);
    assert.equal(value.physical_source,'macos_sysctl_enabled');assert.match(value.physical_scope,/no SMT ratio/);
    assert.equal(detect(),value);assert.equal(calls,1);
  }
});

test('macOS unknown physical cores stay null after timeout, invalid output, or unavailable sysctl',()=>{
  for(const response of [{status:null,error:{code:'ETIMEDOUT'},stdout:'private diagnostic'},{status:1,stdout:'8'},
    ...['0','-1','1.5','NaN','Infinity','65537','17','8\n9',' '.repeat(129)].map(stdout=>({status:0,stdout}))]){
    const value=createCapacityDetector({os:system('darwin',16,8),spawnSync:()=>response})();
    assert.equal(value.physical_cpus,null);assert.equal(value.available_cpus,8);assert.equal(value.physical_source,'unavailable');
    assert.ok(!JSON.stringify(value).includes('private diagnostic'));
  }
  assert.equal(createCapacityDetector({os:system('darwin',16,8),spawnSync:()=>{throw new Error('not installed');}})().physical_cpus,null);
});
