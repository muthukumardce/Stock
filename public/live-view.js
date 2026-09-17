'use strict';

// The transport is independent of rendering so that failed or buffered streams
// can fall back to ordinary authenticated requests without freezing the view.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.createLiveView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  return function createLiveView(options) {
    const interval = options.interval ?? 2000;
    const staleAfter = options.staleAfter ?? 15000;
    const requestTimeout = options.requestTimeout ?? 10000;
    const schedule = options.setTimeout ?? globalThis.setTimeout;
    const cancel = options.clearTimeout ?? globalThis.clearTimeout;
    const Stream = options.EventSource;
    const hostname = (options.hostname || '').toLowerCase();
    const quickTunnel = hostname === 'trycloudflare.com' || hostname.endsWith('.trycloudflare.com');
    let active = false, generation = 0, stream = null;
    let pollTimer = null, staleTimer = null, timeoutTimer = null, controller = null;

    function status(text, color = 'amber') { options.onStatus({text, color}); }
    function closeStream() {
      if (stream) { stream.close(); stream = null; }
      cancel(staleTimer); staleTimer = null;
    }
    function stop() {
      active = false; generation++;
      closeStream();
      cancel(pollTimer); cancel(timeoutTimer);
      pollTimer = timeoutTimer = null;
      if (controller) { controller.abort(); controller = null; }
    }
    function expire() { stop(); options.onExpired(); }
    function current(version) { return active && generation === version; }
    function accept(data) {
      if (!data || !data.state || typeof data.state !== 'object') throw new Error('Invalid state response');
      options.onUpdate(data);
    }
    async function poll(version) {
      if (!current(version)) return;
      const request = new AbortController();
      controller = request;
      timeoutTimer = schedule(() => request.abort(), requestTimeout);
      try {
        const data = await options.fetchState({signal: request.signal});
        if (!current(version)) return;
        accept(data);
        status('Live view · polling', 'green');
      } catch (error) {
        if (!current(version)) return;
        if (error.status === 401) { expire(); return; }
        status('Reconnecting · polling');
      } finally {
        // An old, cancelled request must not clear a newer session's timer.
        if (current(version)) {
          cancel(timeoutTimer); timeoutTimer = null; controller = null;
          pollTimer = schedule(() => poll(version), interval);
        }
      }
    }
    function polling(version) {
      if (!current(version)) return;
      closeStream();
      status('Connecting · polling');
      poll(version);
    }
    function watch(version) {
      cancel(staleTimer);
      staleTimer = schedule(() => polling(version), staleAfter);
    }
    function start() {
      if (active) return;
      active = true;
      const version = ++generation;
      if (quickTunnel || typeof Stream !== 'function') { polling(version); return; }
      status('Connecting · stream');
      try {
        const connection = new Stream(`/api/stream?after=${Number(options.after()) || 0}`);
        stream = connection;
        const connected = () => current(version) && stream === connection;
        connection.addEventListener('update', event => {
          if (!connected()) return;
          try {
            accept(JSON.parse(event.data));
            status('Live view · stream', 'green');
            watch(version);
          } catch (_) { polling(version); }
        });
        connection.addEventListener('expired', () => { if (connected()) expire(); });
        connection.addEventListener('error', () => { if (connected()) polling(version); });
        watch(version);
      } catch (_) { polling(version); }
    }
    return {start, stop};
  };
});
