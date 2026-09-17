// Offline lifecycle fixture: deliberately prevents JavaScript IPC cleanup.
process.send({type:'blocked',process_id:process.pid},()=>{
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
  process.exit(0);
});
