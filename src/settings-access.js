/** Settings changes must not interrupt live ownership or an armed entry loop.
 * Paused simulated positions can be retained through a settings change. */
export function settingsBlocker(view, restartRequired = false) {
  const blocked = (code,message) => ({code,message});
  const symbols = rows => [...new Set(rows.map(row=>row.symbol||row.tradingsymbol).filter(Boolean))].slice(0,6).join(', ');
  if (restartRequired) return blocked('restart_required','An earlier application-settings change is waiting for a server restart. Stop StockPilot with Ctrl+C, then run npm start before saving more settings.');
  if (view.entries_enabled ?? (view.status === 'running')) return blocked('entries_enabled','Automatic entries are still enabled, even if no order is being placed. Select Overview → Pause entries, then save your settings.');
  if (view.unmanaged_live_exposure) return blocked('saved_live_exposure','Saved live positions or orders remain unresolved from live mode. Check the real account in Kite → Orders and Positions and resolve the saved live recovery state before changing settings.');
  const livePositions = (view.positions||[]).filter(position=>view.mode!=='paper'||position.mode==='live');
  const delivery = Object.entries(view.delivery?.positions||{}).filter(([,position])=>position.status!=='closed').map(([symbol,position])=>({...position,symbol}));
  if (livePositions.length || delivery.length) {
    const names=symbols([...livePositions,...delivery]);
    return blocked('live_positions',`Trading is paused, but managed live positions or delivery protection remain${names?`: ${names}`:''}. Review Overview → Managed positions and Kite → Orders and Positions. Settings can be saved after those live records are resolved.`);
  }
  if (view.pending_orders?.length) {
    const names=symbols(view.pending_orders);
    return blocked('pending_orders',`Trading is paused, but ${view.pending_orders.length} pending or unresolved order record(s) remain${names?`: ${names}`:''}. Check Orders & trades and Overview → Entry readiness; wait for reconciliation before saving settings.`);
  }
  return null;
}
