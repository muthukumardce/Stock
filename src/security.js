import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, verify } from '@node-rs/argon2';

export const hashPassword = value => hash(value, { memoryCost: 65536, timeCost: 3, parallelism: 4, outputLen: 32 });
export async function verifyPassword(encoded, password) { try { return await verify(encoded, password); } catch { return false; } }
export const randomSecret = (size = 48) => crypto.randomBytes(size).toString('base64url');
export const digest_token = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('hex');
export function constantEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// Fernet wire compatibility preserves Python-created encrypted broker sessions.
export class Fernet {
  constructor(key) { this.key = Buffer.from(key, 'base64'); if (this.key.length !== 32) throw new Error('Invalid encryption key'); }
  encrypt(value) {
    const iv = crypto.randomBytes(16), header = Buffer.alloc(9); header[0] = 0x80; header.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000)), 1);
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key.subarray(16), iv);
    const body = Buffer.concat([header, iv, cipher.update(Buffer.from(value)), cipher.final()]);
    return Buffer.concat([body, crypto.createHmac('sha256', this.key.subarray(0, 16)).update(body).digest()]).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  }
  decrypt(value) {
    const token = Buffer.from(value, 'base64'), body = token.subarray(0, -32), mac = token.subarray(-32);
    if (token.length < 73 || token[0] !== 0x80 || !constantEqual(crypto.createHmac('sha256', this.key.subarray(0, 16)).update(body).digest('hex'), mac.toString('hex'))) throw new Error('Invalid encrypted session');
    const cipher = crypto.createDecipheriv('aes-128-cbc', this.key.subarray(16), token.subarray(9, 25));
    return Buffer.concat([cipher.update(token.subarray(25, -32)), cipher.final()]).toString('utf8');
  }
}
export class ProcessLock {
  constructor(filename) { this.filename = filename; }
  acquire() {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filename);
    try { this.db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE;'); }
    catch { this.db.close(); this.db = null; throw new Error('Another StockPilot process owns this data directory. Run one server.'); }
  }
  release() { if (this.db) { this.db.close(); this.db = null; } }
}
export class LoginLimiter {
  constructor(store) { this.store = store; }
  keys(ip) { return ['login_global', 'login_ip:' + crypto.createHash('sha256').update(ip).digest('hex')]; }
  check(ip) { const now = Date.now()/1000; return this.keys(ip).every(key => this.store.get(key, []).filter(t => t > now - 900).length < (key === 'login_global' ? 30 : 5)); }
  failure(ip) { const now = Date.now()/1000; for (const key of this.keys(ip)) this.store.set(key, [...this.store.get(key, []).filter(t => t > now - 900), now]); }
}

export function strictJSON(bytes) {
  const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  let i=0;
  const whitespace=()=>{while(/[ \t\r\n]/.test(text[i]||'')&&i<text.length)i++;};
  function string(){const start=i++;let escaped=false;while(i<text.length){const c=text[i++];if(!escaped&&c==='"')return JSON.parse(text.slice(start,i));if(!escaped&&c==='\\')escaped=true;else escaped=false;}throw new Error('Unterminated JSON string');}
  function value(depth=0){if(depth>100)throw new Error('JSON nesting too deep');whitespace();if(text[i]==='"')return string();if(text[i]==='{'){i++;const result=Object.create(null),keys=new Set();whitespace();if(text[i]==='}'){i++;return result;}while(true){whitespace();if(text[i]!=='"')throw new Error('Invalid JSON key');const key=string();if(keys.has(key))throw new Error('Duplicate JSON field');keys.add(key);whitespace();if(text[i++]!==':')throw new Error('Missing colon');result[key]=value(depth+1);whitespace();const c=text[i++];if(c==='}')return result;if(c!==',')throw new Error('Invalid object');}}
    if(text[i]==='['){i++;const result=[];whitespace();if(text[i]===']'){i++;return result;}while(true){result.push(value(depth+1));whitespace();const c=text[i++];if(c===']')return result;if(c!==',')throw new Error('Invalid array');}}
    const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));if(!match)throw new Error('Invalid JSON value');i+=match[0].length;const result=JSON.parse(match[0]);if(typeof result==='number'&&!Number.isFinite(result))throw new Error('Nonfinite JSON number');return result;}
  const result=value();whitespace();if(i!==text.length)throw new Error('Trailing JSON content');return result;
}
