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
