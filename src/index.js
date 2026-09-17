import { ConfigManager } from './config.js';
import { createApp } from './main.js';
import { root, initialPassword } from './cli.js';

let app,server,stopping=false;
async function stop(signal) {
  if(stopping)return;stopping=true;
  console.log(`\n${signal}: pausing execution and closing the server.`);
  const timeout=setTimeout(()=>{console.error('Shutdown timed out. Review broker orders before restarting.');process.exit(1);},45000);timeout.unref();
  server?.close();
  try{await app?.shutdown();server?.closeAllConnections();clearTimeout(timeout);}catch{console.error('Shutdown did not complete cleanly. Review broker orders before restarting.');process.exitCode=1;}
}
try {
  const manager=new ConfigManager(root),settings=await manager.load({onInitialPassword:initialPassword});
  app=await createApp({settings,configManager:manager});
  server=await new Promise((resolve,reject)=>{const listener=app.listen(settings.port,'127.0.0.1',()=>resolve(listener));listener.once('error',reject);});
  console.log(`StockPilot: http://localhost:${settings.port}\nMode: ${settings.trading_mode}. New entries are paused until Start Trading.\nStop with Ctrl+C.`);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop(signal));
} catch(error) {
  console.error(error.code==='EADDRINUSE'?'The configured port is already in use. Stop the other server first.':'Startup failed: '+(error.message||'unknown error'));
  await app?.shutdown();process.exitCode=1;
}
