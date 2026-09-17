/** Reap exact owned POSIX child PIDs after their research Worker has exited.
 * Closing a Unix libuv process handle before child exit removes its reaper:
 * https://docs.libuv.org/en/v1.x/process.html#c.uv_spawn
 * Callers must never use this while the original coordinator owns that handle.
 */
import {createRequire} from 'node:module';
import {isMainThread} from 'node:worker_threads';
const require=createRequire(import.meta.url),WNOHANG=1;
const result=(status,code)=>({status,pid:null,code});

function nativeBackend(platform){
  const koffi=require('koffi');let library;
  for(const name of platform==='darwin'?['/usr/lib/libSystem.B.dylib']:['libc.so.6','libc.so'])try{library=koffi.load(name);break;}catch{}
  if(!library)throw new Error('POSIX process reaping is unavailable');
  return {waitpid:library.func('int waitpid(int pid, _Out_ void *status, int options)'),errno:()=>koffi.errno(),
    interrupted:koffi.os.errno.EINTR,noChild:koffi.os.errno.ECHILD};
}

export function createResearchProcessReaper({platform=process.platform,loadNative=nativeBackend,isMain=()=>isMainThread}={}){
  let backend,unavailable=false;
  return function reap(pid,{coordinatorExited=false}={}){
    if(platform==='win32')return result('unavailable','not_needed');
    if(!['linux','darwin'].includes(platform))return result('unavailable','unsupported_platform');
    if(!isMain())return result('unavailable','main_thread_required');
    if(coordinatorExited!==true)return result('unavailable','coordinator_active');
    // Never pass0/-1/process-group selectors to waitpid: unrelated child status
    // belongs to its own libuv handle and must not be consumed by this registry.
    if(!Number.isSafeInteger(pid)||pid<1||pid>0x7fffffff)return result('error','invalid_pid');
    if(unavailable)return result('unavailable','native_unavailable');
    if(!backend)try{
      backend=loadNative(platform);
      if(typeof backend?.waitpid!=='function'||typeof backend?.errno!=='function'||!Number.isInteger(backend.interrupted)||!Number.isInteger(backend.noChild))throw new Error('Invalid native reaper');
    }catch{unavailable=true;return result('unavailable','native_unavailable');}
    const status=Buffer.alloc(4);
    try{
      for(let attempt=0;attempt<4;attempt++){
        const waited=backend.waitpid(pid,status,WNOHANG);
        if(waited===pid)return {status:'reaped',pid};
        if(waited===0)return {status:'running',pid:0};
        if(waited!==-1)return result('error','unexpected_pid');
        const errno=backend.errno();
        if(errno===backend.noChild)return result('unavailable','not_child');
        if(errno!==backend.interrupted)return result('error','wait_failed');
      }
      return result('error','interrupted');
    }catch{return result('error','wait_failed');}
  };
}

const reap=createResearchProcessReaper();
export const reapResearchProcess=(pid,options)=>reap(pid,options);
