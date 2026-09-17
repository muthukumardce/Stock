/** Cached CPU capacity estimates; this module never changes processor affinity.
 * Windows 11/Server 2022 default to all processor groups:
 * https://learn.microsoft.com/en-us/windows/win32/procthread/processor-groups
 * Runtime usable parallelism is preferred on other platforms:
 * https://nodejs.org/api/os.html#osavailableparallelism
 */
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const MAX_CPUS=65536;
const validCount=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=MAX_CPUS;
const UNKNOWN_PHYSICAL='Physical core count could not be verified. Research may use the eligible logical CPU count as a scheduling estimate; it is not a verified physical core count.';

// Sysfs/procfs CPU lists have a bounded numeric range grammar. Expanding a
// repeated large range must not turn a small input into unbounded parsing work.
function cpuList(text){
  if(typeof text!=='string'||text.length>MAX_CPUS*6||!text.trim())throw new Error('Invalid CPU list');
  const cpus=new Set();let expanded=0;
  for(const item of text.trim().split(',')){
    const match=/^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item);if(!match)throw new Error('Invalid CPU range');
    const first=Number(match[1]),last=Number(match[2]??match[1]);
    if(first>=MAX_CPUS||last>=MAX_CPUS||last<first||(expanded+=last-first+1)>MAX_CPUS)throw new Error('CPU list exceeds bounds');
    for(let cpu=first;cpu<=last;cpu++)cpus.add(cpu);
  }
  return cpus;
}
function topologyId(value){
  if(typeof value!=='string'||value.length>16||!/^\d{1,5}\s*$/.test(value))throw new Error('Unknown CPU topology');
  const id=Number(value);if(id>=MAX_CPUS)throw new Error('CPU topology exceeds bounds');return id;
}
function linuxPhysical(read,available){
  // thread-self follows the actual calling Node thread, including a research
  // coordinator. Older kernels may only expose the process/main-thread mask.
  let status,source='linux_sysfs_thread_allowed';
  try{status=read('/proc/thread-self/status','utf8');}
  catch{status=read('/proc/self/status','utf8');source='linux_sysfs_process_allowed';}
  if(typeof status!=='string'||status.length>1024*1024)throw new Error('Invalid process CPU status');
  const matches=[...status.matchAll(/^Cpus_allowed_list:[ \t]*([^\r\n]+)$/gm)];
  if(matches.length!==1)throw new Error('CPU allowance could not be read');
  const allowed=cpuList(matches[0][1]),online=cpuList(read('/sys/devices/system/cpu/online','utf8')),cores=new Set();
  for(const cpu of allowed){
    if(!online.has(cpu))continue;
    const base=`/sys/devices/system/cpu/cpu${cpu}/topology/`;
    const packageId=topologyId(read(base+'physical_package_id','utf8')),coreId=topologyId(read(base+'core_id','utf8'));
    cores.add(packageId+':'+coreId);
  }
  if(!cores.size)throw new Error('No verified eligible physical cores');
  return {physical_cpus:Math.min(cores.size,available),physical_source:source,
    physical_scope:source==='linux_sysfs_thread_allowed'
      ?'Distinct physical package/core pairs among this thread\'s allowed online CPUs, capped by runtime usable parallelism. No SMT ratio is assumed.'
      :'Distinct physical package/core pairs among the process\'s allowed online CPUs, capped by runtime usable parallelism. The older-kernel process mask is an estimate for another calling thread.'};
}
// Constant, read-only script: no application setting, account data, command-line
// argument, or environment value is interpolated into PowerShell source.
const WINDOWS_PROBE=String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$capacityProcessors = @(Get-CimInstance -ClassName Win32_Processor -Property NumberOfLogicalProcessors,NumberOfCores)
$capacityOS = Get-CimInstance -ClassName Win32_OperatingSystem -Property BuildNumber,ProductType
$capacityAffinity = $null
try {
  $capacitySelf = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$PID" -Property ParentProcessId
  $capacityParent = Get-Process -Id $capacitySelf.ParentProcessId -ErrorAction Stop
  $capacityAffinity = ([Convert]::ToString($capacityParent.ProcessorAffinity.ToInt64(), 2).ToCharArray() | Where-Object { $_ -eq '1' } | Measure-Object).Count
} catch { $capacityAffinity = $null }
[ordered]@{
  logical_cpus = [int](($capacityProcessors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
  physical_cpus = [int](($capacityProcessors | Measure-Object -Property NumberOfCores -Sum).Sum)
  build = [int]$capacityOS.BuildNumber
  product_type = [int]$capacityOS.ProductType
  primary_group_affinity_cpus = $capacityAffinity
} | ConvertTo-Json -Compress
`;

/** Dependency injection is exposed for deterministic OS/timeout tests only. */
export function createCapacityDetector({os:system=os,spawnSync:run=spawnSync,readFileSync:read=readFileSync}={}){
  let cached;
  return function detect(){
    if(cached)return cached;
    let runtimeCpus=0,runtimeAvailable=0,platform='unknown';
    try{const cpus=system.cpus();if(Array.isArray(cpus)&&validCount(cpus.length))runtimeCpus=cpus.length;}catch{}
    try{const available=system.availableParallelism();if(validCount(available))runtimeAvailable=available;}catch{}
    try{platform=system.platform();}catch{}
    runtimeAvailable ||= runtimeCpus || 1;runtimeCpus ||= runtimeAvailable;
    const result={logical_cpus:Math.max(runtimeCpus,runtimeAvailable),available_cpus:runtimeAvailable,
      runtime_cpus:runtimeCpus,runtime_available_cpus:runtimeAvailable,physical_cpus:null,physical_source:'unavailable',physical_scope:UNKNOWN_PHYSICAL,
      source:'runtime_available_parallelism',scope:'Runtime parallelism estimate; operating-system affinity and container restrictions reported by the runtime are respected. Hardware metadata is not a utilization guarantee.'};
    if(platform==='win32'){
      result.source='windows_runtime_fallback';
      result.scope='Windows runtime estimate may cover one processor group. Machine-wide capacity could not be verified; an explicit worker setting is available, but affinity is never changed.';
      try{
        const response=run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_PROBE],{
          encoding:'utf8',timeout:3000,maxBuffer:16384,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false,
        });
        if(response.error||response.status!==0||typeof response.stdout!=='string'||response.stdout.length>16384)throw new Error('Probe unavailable');
        const observed=JSON.parse(response.stdout.replace(/^\uFEFF/,''));
        if(!observed||!validCount(observed.logical_cpus)||observed.logical_cpus<Math.max(runtimeCpus,runtimeAvailable)
          ||!Number.isSafeInteger(observed.build)||observed.build<0||!Number.isSafeInteger(observed.product_type)||![1,2,3].includes(observed.product_type))throw new Error('Invalid capacity observation');
        result.logical_cpus=observed.logical_cpus;
        if(validCount(observed.physical_cpus)&&observed.physical_cpus<=observed.logical_cpus){
          result.physical_cpus=observed.physical_cpus;result.physical_source='windows_cim_machine';
          result.physical_scope='CIM machine physical core count; it does not identify which cores remain eligible under process, thread, CPU-set, or job restrictions.';
        }
        const supported=observed.product_type===1?observed.build>=22000:observed.build>=20348;
        const groupWidth=Math.min(runtimeCpus,64),affinity=observed.primary_group_affinity_cpus;
        const affinityVerified=validCount(affinity)&&affinity<=64,restricted=runtimeAvailable<groupWidth||affinityVerified&&affinity<groupWidth;
        if(supported&&affinityVerified&&!restricted&&observed.logical_cpus>runtimeAvailable){
          result.available_cpus=observed.logical_cpus;result.source='windows_cim_all_groups_estimate';
          result.scope='CIM machine total used as an all-group scheduling estimate on Windows 11/Server 2022 or newer; no reduced primary-group affinity was detected. CPU-set/job restrictions and actual worker distribution are not fully verified. This is not a utilization guarantee; a manual worker setting remains available.';
        }else{
          result.source=restricted?'windows_cim_runtime_restricted':'windows_cim_machine_only';
          if(restricted)result.available_cpus=Math.min(runtimeAvailable,affinityVerified?affinity:runtimeAvailable);
          result.scope=restricted?'CIM reports machine hardware, but a runtime or primary-group affinity restriction was detected; usable capacity honors the smaller observed limit. No affinity was changed.'
            :!supported?'CIM reports machine hardware; this Windows build does not have verified default all-group scheduling, so usable capacity retains the runtime limit.'
            :!affinityVerified?'CIM reports machine hardware, but primary-group affinity could not be verified; usable capacity retains the runtime limit. A manual worker setting is available.'
            :'CIM machine hardware and runtime capacity agree. Actual affinity, CPU-set/job limits and worker utilization are not guaranteed by the hardware count.';
        }
      }catch{/* Never expose subprocess diagnostics or trust inherited CPU-count environment variables. */}
    }else if(platform==='linux'){
      // Kernel topology and effective allowed lists are read without a native
      // FFI dependency or changing the thread/process affinity.
      // https://www.kernel.org/doc/html/latest/admin-guide/cputopology.html
      try{Object.assign(result,linuxPhysical(read,result.available_cpus));}catch{}
    }else if(platform==='darwin'){
      // Apple exposes enabled physical cores directly, including Apple silicon
      // where logical/2 would undercount. This is a fixed read-only sysctl query.
      // https://developer.apple.com/documentation/kernel/1387446-sysctlbyname/determining_system_capabilities
      try{
        const response=run('/usr/sbin/sysctl',['-n','hw.physicalcpu'],{encoding:'utf8',timeout:1000,maxBuffer:1024,windowsHide:true,stdio:['ignore','pipe','ignore'],shell:false});
        if(response.error||response.status!==0||typeof response.stdout!=='string'||response.stdout.length>128||!/^\d{1,5}$/.test(response.stdout.trim()))throw new Error('Physical CPU query unavailable');
        const physical=Number(response.stdout.trim());if(!validCount(physical)||physical>result.logical_cpus)throw new Error('Invalid physical CPU count');
        result.physical_cpus=Math.min(physical,result.available_cpus);result.physical_source='macos_sysctl_enabled';
        result.physical_scope='Enabled physical cores reported by hw.physicalcpu, capped by runtime usable logical CPUs. Individual eligible core identities are not exposed; no SMT ratio is assumed.';
      }catch{}
    }
    cached=Object.freeze(result);return cached;
  };
}

export const detectCapacity=createCapacityDetector();
