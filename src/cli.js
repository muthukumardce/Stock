import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConfigManager } from './config.js';
import { ProcessLock } from './security.js';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function initialPassword(password) {
  console.log(`\nAdministrator username: admin\nInitial password: ${password}\nSave this password now. Change it in Settings after signing in.\n`);
}
async function main() {
  const command=process.argv[2];
  if(!['setup','check'].includes(command))throw new Error('Use npm run setup, npm run check, or npm start');
  const manager=new ConfigManager(root);
  if(command==='check'&&!fs.existsSync(manager.filename))throw new Error('Run npm run setup first');
  if(command==='setup'&&!fs.existsSync(path.join(root,'.env')))fs.copyFileSync(path.join(root,'.env.example'),path.join(root,'.env'),fs.constants.COPYFILE_EXCL);
  const settings=await manager.load({onInitialPassword:initialPassword});
  fs.mkdirSync(settings.data_dir,{recursive:true,mode:0o700});
  if(command==='setup') {
    console.log('Settings saved in config/settings.json. Add only the three Kite credentials to .env.');
    if(!manager.initialPassword)console.log('Existing administrator credentials and settings were preserved.');
    console.log(`Run npm start, then open http://localhost:${settings.port}`);
    return;
  }
  const lock=new ProcessLock(path.join(settings.data_dir,'server-owner.sqlite3'));
  lock.acquire();lock.release();
  const cpus=os.cpus().length||os.availableParallelism(),limit=Math.max(1,cpus-settings.analytics_reserve_cpus);
  console.log(`Configuration valid. Node ${process.version}; ${cpus} logical CPUs; analytics capacity ${settings.analytics_workers?Math.min(cpus,settings.analytics_workers):limit} workers.`);
  console.log(`Data directory: ${settings.data_dir}\nKite credentials: ${settings.configured?'configured':'not set; add the three Kite values to .env'}`);
  console.log('Local validation only. No Zerodha requests or orders were made.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
