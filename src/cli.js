import fs from 'node:fs';
import path from 'node:path';
import {detectCapacity} from './capacity.js';
import { fileURLToPath } from 'node:url';
import { ConfigManager } from './config.js';
import { ProcessLock } from './security.js';
import {runOfflineResearch,backupApplication} from './offline-tools.js';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function initialPassword(password) {
  console.log(`\nAdministrator username: admin\nInitial password: ${password}\nSave this password now. Change it in Settings after signing in.\n`);
}
export function ensurePrivateEnvironment(projectRoot) {
  const filename=path.join(projectRoot,'.env');let fd,created=false;
  try {
    try { fd=fs.openSync(filename,'wx',0o600);created=true; }
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      const before=fs.lstatSync(filename);
      if(!before.isFile()||before.isSymbolicLink())throw new Error('Kite .env must be a regular file, not a symbolic link');
      if(process.platform!=='win32'&&typeof process.geteuid==='function'&&before.uid!==process.geteuid())throw new Error('Run setup as the operating-system user who owns .env');
      // Do not follow a replacement link or block on a replacement FIFO while
      // hardening an existing secret file. Windows has no POSIX ACL equivalent.
      fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
      const opened=fs.fstatSync(fd);
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('Kite .env changed during setup; retry after checking the file');
    }
    if(process.platform!=='win32')fs.fchmodSync(fd,0o600);
    if(created)fs.writeFileSync(fd,fs.readFileSync(path.join(projectRoot,'.env.example')));
    if(created)fs.fsyncSync(fd);
    return {created};
  } catch(error) {
    if(fd!==undefined){fs.closeSync(fd);fd=undefined;}
    if(created)fs.unlinkSync(filename);
    throw error;
  } finally { if(fd!==undefined)fs.closeSync(fd); }
}
async function main() {
  const command=process.argv[2];
  if(command==='research'){
    const [input,output,capital,interval='5minute',...extra]=process.argv.slice(3);
    if(!input||!output||capital===undefined||extra.length)throw new Error('Use: node src/cli.js research <dataset.json|csv> <new-report.json> <capital> [5minute|day]');
    const result=await runOfflineResearch(input,output,Number(capital),interval);
    console.log(`Offline research saved: ${result.destination}\nBaseline trades: ${result.baseline_trades}; enhanced trades: ${result.enhanced_trades}.`);
    if(!result.comparison_complete)console.log('Unresolved positions remain marked in the report; this is not a completed trading result.');
    console.log('No Zerodha connection, account changes, or orders were made.');return;
  }
  if(command==='backup'){
    const [destination,...extra]=process.argv.slice(3);if(!destination||extra.length)throw new Error('Use: node src/cli.js backup <new-directory>');
    const result=await backupApplication(root,destination);console.log(`Private backup saved: ${result.destination}\nDatabase integrity verified. Configuration, credentials and journal must be restored together.`);return;
  }
  if(!['setup','check'].includes(command))throw new Error('Use setup, check, research <dataset> <new-report> <capital> [5minute|day], backup <new-directory>, or npm start');
  const manager=new ConfigManager(root);
  if(command==='check'&&!fs.existsSync(manager.filename))throw new Error('Run npm run setup first');
  if(command==='setup')ensurePrivateEnvironment(root);
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
  const capacity=detectCapacity(),cpus=capacity.logical_cpus,limit=Math.max(1,capacity.available_cpus-settings.analytics_reserve_cpus);
  console.log(`Configuration valid. Node ${process.version}; ${cpus} logical CPUs; analytics capacity ${settings.analytics_workers?Math.min(cpus,settings.analytics_workers):limit} workers.`);
  console.log(`CPU estimate: ${capacity.source}. ${capacity.scope}`);
  console.log(`Data directory: ${settings.data_dir}\nKite credentials: ${settings.configured?'configured':'not set; add the three Kite values to .env'}`);
  console.log('Local validation only. No Zerodha requests or orders were made.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
