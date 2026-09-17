/** Cached CPU capacity estimates; this module never changes processor affinity.
 * Windows 11/Server 2022 default to all processor groups:
 * https://learn.microsoft.com/en-us/windows/win32/procthread/processor-groups
 * Runtime usable parallelism is preferred on other platforms:
 * https://nodejs.org/api/os.html#osavailableparallelism
 */
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const MAX_CPUS=65536;
const validCount=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=MAX_CPUS;
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
export function createCapacityDetector({os:system=os,spawnSync:run=spawnSync}={}){
  let cached;
  return function detect(){
    if(cached)return cached;
    let runtimeCpus=0,runtimeAvailable=0,platform='unknown';
    try{const cpus=system.cpus();if(Array.isArray(cpus)&&validCount(cpus.length))runtimeCpus=cpus.length;}catch{}
    try{const available=system.availableParallelism();if(validCount(available))runtimeAvailable=available;}catch{}
    try{platform=system.platform();}catch{}
    runtimeAvailable ||= runtimeCpus || 1;runtimeCpus ||= runtimeAvailable;
    const result={logical_cpus:Math.max(runtimeCpus,runtimeAvailable),available_cpus:runtimeAvailable,
      runtime_cpus:runtimeCpus,runtime_available_cpus:runtimeAvailable,physical_cpus:null,
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
        if(validCount(observed.physical_cpus)&&observed.physical_cpus<=observed.logical_cpus)result.physical_cpus=observed.physical_cpus;
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
    }
    cached=Object.freeze(result);return cached;
  };
}

export const detectCapacity=createCapacityDetector();
