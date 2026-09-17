import { isIP } from 'node:net';

// The server listens only on loopback. Only the local cloudflared process may
// supply proxy metadata; X-Forwarded-Host is deliberately never trusted.
export function requestContext(req) {
  const peer=req.socket.remoteAddress || '';
  const loopback=peer==='::1'||peer==='127.0.0.1'||peer==='::ffff:127.0.0.1';
  const raw=req.headers.host || '';
  if(!raw || /[\s/@\\?#,]/.test(raw))throw new Error('Unrecognized host');
  const parsed=new URL('http://'+raw);
  const local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
  const cloudflare=loopback && /^[a-f0-9]{16,32}-[a-z]{3}$/i.test(req.headers['cf-ray']||'');
  const secure=cloudflare && req.headers['x-forwarded-proto']==='https';
  if(!loopback || (!local && !secure))throw new Error('Use localhost or an HTTPS Cloudflare tunnel');
  const origin=new URL((secure?'https://':'http://')+raw).origin;
  const forwarded=req.headers['cf-connecting-ip'];
  return {origin,secure,ip:cloudflare&&isIP(forwarded||'')?forwarded:peer};
}
