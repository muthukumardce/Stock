/** Local research and paired recovery backups. No broker is imported or called. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync, backup as sqliteBackup} from 'node:sqlite';
import dotenv from 'dotenv';
import {Settings,pathWithin} from './config.js';
import {ProcessLock} from './security.js';
import {parseDataset} from './backtest.js';
import {ResearchService} from './research.js';

const MAX_DATASET_BYTES=64*1024*1024;
function inside(target,directory){const relative=path.relative(directory,target);return relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);}
function existingFile(filename,label){
  const stat=fs.lstatSync(filename);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`${label} must be a regular file`);
  return filename;
}
function readBounded(filename,limit,label){
  existingFile(filename,label);const fd=fs.openSync(filename,'r'),chunks=[];let size=0;
  try{
    if(fs.fstatSync(fd).size>limit)throw new Error(`${label} exceeds its size limit`);
    for(;;){const chunk=Buffer.allocUnsafe(Math.min(65536,limit-size+1)),length=fs.readSync(fd,chunk,0,chunk.length,null);if(!length)break;size+=length;if(size>limit)throw new Error(`${label} exceeds its size limit`);chunks.push(chunk.subarray(0,length));}
  }finally{fs.closeSync(fd);}
  return Buffer.concat(chunks,size);
}
function newDestination(filename){
  const absolute=path.resolve(filename),parent=fs.realpathSync(path.dirname(absolute)),target=path.join(parent,path.basename(absolute));
  if(fs.existsSync(target)||fs.lstatSync(parent).isSymbolicLink())throw new Error('Destination must not already exist');
  return target;
}
function writePrivate(filename,data){
  const fd=fs.openSync(filename,'wx',0o600);
  try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}catch(error){fs.closeSync(fd);fs.unlinkSync(filename);throw error;}
  fs.closeSync(fd);fs.chmodSync(filename,0o600);
}
const checksum=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
function checkCredentialOverrides(envBytes,environment){
  const file=dotenv.parse(envBytes),normalize=(key,value)=>{const result=String(value||'').trim();return key==='KITE_USER_ID'?result.toUpperCase():result;};
  for(const key of ['KITE_API_KEY','KITE_API_SECRET','KITE_USER_ID']){
    if(Object.hasOwn(environment,key)&&normalize(key,environment[key])!==normalize(key,file[key]))throw new Error('Backup refused: a Kite process-environment override differs from .env. Make the intended credentials consistent before backing up; process secrets are not exported.');
  }
}

export async function runOfflineResearch(inputFilename,outputFilename,capital,interval='5minute'){
  if(!Number.isFinite(capital)||capital<=0||capital>1e12)throw new Error('Offline research requires an explicit positive capital amount, at most 1e12');
  if(!['5minute','day'].includes(interval))throw new Error('Research interval must be 5minute or day');
  const input=path.resolve(inputFilename),destination=newDestination(outputFilename),extension=path.extname(input).toLowerCase();
  if(!['.json','.csv'].includes(extension))throw new Error('Dataset filename must end in .json or .csv');
  let dataset;
  try{dataset=parseDataset(new TextDecoder('utf-8',{fatal:true}).decode(readBounded(input,MAX_DATASET_BYTES,'Dataset')),{format:extension.slice(1),interval});}
  catch{throw new Error('Cannot import dataset: use valid chronological JSON/CSV OHLCV within the 64 MiB and 250000-bar limits');}
  const worker=new ResearchService();
  try{
    worker.start(dataset,{initial_capital:capital});const job=await worker.wait();
    if(job.status!=='complete'||!job.result)throw new Error('Offline research could not complete; check candle coverage and resource limits');
    writePrivate(destination,JSON.stringify(job.result,null,2)+'\n');
    return {destination,baseline_trades:job.result.baseline.metrics.trade_count,enhanced_trades:job.result.enhanced.metrics.trade_count,
      comparison_complete:job.result.comparison_complete};
  }finally{await worker.close();}
}

/** Back up one stopped application's journal with its exact matching encryption settings. */
export async function backupApplication(projectRoot,destinationDirectory,{environment=process.env}={}){
  const root=fs.realpathSync(path.resolve(projectRoot)),configFile=path.join(root,'config','settings.json'),envFile=path.join(root,'.env');
  let configBytes,saved,settings;
  try{configBytes=readBounded(configFile,1024*1024,'Configuration');saved=JSON.parse(configBytes.toString('utf8'));settings=new Settings(saved,root).validate();}
  catch{throw new Error('Backup requires an existing valid config/settings.json; run setup first');}
  const dataDirectory=fs.realpathSync(settings.data_dir),databaseFile=existingFile(path.join(dataDirectory,'stockpilot.sqlite3'),'Trading journal');
  const destination=newDestination(destinationDirectory);
  if(inside(destination,dataDirectory)||inside(destination,path.dirname(configFile)))throw new Error('Backup destination must be outside the data and configuration directories');
  if(pathWithin(destination,path.join(root,'public')))throw new Error('Backup destination must be outside publicly served files');
  const lock=new ProcessLock(path.join(dataDirectory,'server-owner.sqlite3'));lock.acquire();
  const createdFiles=[],createdDirectories=[];let source=null;
  try{
    if(!configBytes.equals(readBounded(configFile,1024*1024,'Configuration')))throw new Error('Configuration changed; retry the stopped-server backup');
    const envBytes=readBounded(envFile,1024*1024,'Kite environment file');
    checkCredentialOverrides(envBytes,environment);
    fs.mkdirSync(destination,{mode:0o700});createdDirectories.push(destination);
    const configurationDirectory=path.join(destination,'config'),snapshotDirectory=path.join(destination,'data');
    for(const directory of [configurationDirectory,snapshotDirectory]){fs.mkdirSync(directory,{mode:0o700});createdDirectories.push(directory);}
    const snapshot=path.join(snapshotDirectory,'stockpilot.sqlite3');writePrivate(snapshot,Buffer.alloc(0));createdFiles.push(snapshot,snapshot+'-wal',snapshot+'-shm');
    source=new DatabaseSync(databaseFile,{readOnly:true});source.exec('BEGIN');source.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    await sqliteBackup(source,snapshot);source.close();source=null;fs.chmodSync(snapshot,0o600);
    const verification=new DatabaseSync(snapshot);
    try{verification.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');if(verification.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup integrity check failed');}finally{verification.close();}
    if(!configBytes.equals(readBounded(configFile,1024*1024,'Configuration'))||!envBytes.equals(readBounded(envFile,1024*1024,'Kite environment file')))throw new Error('Configuration or credentials changed; retry the stopped-server backup');
    checkCredentialOverrides(envBytes,environment);
    const configTarget=path.join(configurationDirectory,'settings.json'),envTarget=path.join(destination,'.env');
    writePrivate(configTarget,configBytes);createdFiles.push(configTarget);writePrivate(envTarget,envBytes);createdFiles.push(envTarget);
    const manifest={version:1,created_at:new Date().toISOString(),node_version:process.version,database:'data/stockpilot.sqlite3',
      original_data_directory:dataDirectory,configuration:'config/settings.json',credentials:'.env',
      credentials_source:'The .env file only. Process and service environment secrets are not exported; verify separately managed credentials before restoring.',
      restore:'With the server stopped, restore the database into the data_dir configured in the matching settings.json, and restore settings.json and .env together. Do not combine this database with different encryption keys.',
      files:{'config/settings.json':{sha256:checksum(configBytes),bytes:configBytes.length},'.env':{sha256:checksum(envBytes),bytes:envBytes.length},
        'data/stockpilot.sqlite3':{sha256:await fileChecksum(snapshot),bytes:fs.statSync(snapshot).size}}};
    const manifestFile=path.join(destination,'manifest.json');writePrivate(manifestFile,JSON.stringify(manifest,null,2)+'\n');createdFiles.push(manifestFile);
    return {destination,files:Object.keys(manifest.files),integrity:'ok'};
  }catch(error){
    // Remove only the exact files and empty directories created by this call.
    for(const filename of createdFiles.reverse())if(inside(filename,destination)){try{fs.unlinkSync(filename);}catch{}}
    for(const directory of createdDirectories.reverse())if(inside(directory,destination)){try{fs.rmdirSync(directory);}catch{}}
    throw error;
  }finally{source?.close();lock.release();}
}
function fileChecksum(filename){return new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256'),stream=fs.createReadStream(filename);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')));});}
