import {Agent} from 'undici';

/** Keep Kite REST traffic on the public IPv4 address used by the IP whitelist.
 * A per-transport dispatcher leaves other services and global DNS untouched.
 * Keep the original hostname for DNS, TLS verification and SNI. */
export function createKiteTransport() {
  const dispatcher = new Agent({connect: {family: 4}, autoSelectFamily: false});
  let closing;
  return {
    fetch: (url, options = {}) => globalThis.fetch(url, {...options, dispatcher}),
    // Finish in-flight requests (especially orders) before releasing sockets.
    close: () => closing ??= dispatcher.close(),
  };
}
