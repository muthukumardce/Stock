import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensurePrivateEnvironment} from '../src/cli.js';

const template="KITE_API_KEY='placeholder-key'\nKITE_API_SECRET='placeholder-secret'\nKITE_USER_ID='AB1234'\n";
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stock-env-permissions-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  fs.writeFileSync(path.join(directory,'.env.example'),template,{mode:0o644});
  return {directory,filename:path.join(directory,'.env')};
}

test('setup creates the credential template without exposing a public-mode file on POSIX',t=>{
  const {directory,filename}=fixture(t);
  assert.deepEqual(ensurePrivateEnvironment(directory),{created:true});
  assert.equal(fs.readFileSync(filename,'utf8'),template);
  if(process.platform!=='win32')assert.equal(fs.statSync(filename).mode&0o777,0o600);
});

test('setup preserves existing credentials and hardens their POSIX permissions',t=>{
  const {directory,filename}=fixture(t),credentials=template.replace('placeholder-secret','existing-fixture-value');
  fs.writeFileSync(filename,credentials,{mode:0o644});
  assert.deepEqual(ensurePrivateEnvironment(directory),{created:false});
  assert.equal(fs.readFileSync(filename,'utf8'),credentials);
  if(process.platform!=='win32')assert.equal(fs.statSync(filename).mode&0o777,0o600);
});

test('setup refuses nonregular credential paths without replacing their contents',t=>{
  const {directory,filename}=fixture(t);fs.mkdirSync(filename);fs.writeFileSync(path.join(filename,'keep'),'unchanged');
  assert.throws(()=>ensurePrivateEnvironment(directory),/regular file/);
  assert.equal(fs.readFileSync(path.join(filename,'keep'),'utf8'),'unchanged');
});

test('setup does not follow credential symlinks or change the linked file',t=>{
  const {directory,filename}=fixture(t),target=path.join(directory,'shared-credentials');fs.writeFileSync(target,template,{mode:0o644});
  try{fs.symlinkSync(target,filename,'file');}catch(error){if(process.platform==='win32'&&['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Creating file symlinks requires Windows privileges');return;}throw error;}
  const before=fs.statSync(target).mode;
  assert.throws(()=>ensurePrivateEnvironment(directory),/regular file/);
  assert.equal(fs.readFileSync(target,'utf8'),template);assert.equal(fs.statSync(target).mode,before);assert.equal(fs.lstatSync(filename).isSymbolicLink(),true);
});

test('a missing template removes only the new empty credential file',t=>{
  const {directory,filename}=fixture(t);fs.unlinkSync(path.join(directory,'.env.example'));
  assert.throws(()=>ensurePrivateEnvironment(directory),/ENOENT/);assert.equal(fs.existsSync(filename),false);
  fs.writeFileSync(filename,template);
  assert.deepEqual(ensurePrivateEnvironment(directory),{created:false});assert.equal(fs.readFileSync(filename,'utf8'),template);
});
