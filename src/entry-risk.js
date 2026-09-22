/** Planned entry economics, shared by execution and chronological research.
 * Entry already includes entry-side spread/slippage/rounding. Exit costs are
 * estimates at the target/stop; gaps and actual fills can produce larger losses.
 */
export const DEFAULT_MIN_ENTRY_REWARD_RISK = 1.5;

export function entryRewardRisk({side, entry, stop, target, fee_rate, exit_slippage_rate,
  min_reward_risk = DEFAULT_MIN_ENTRY_REWARD_RISK}) {
  const inputs = {side, entry, stop, target, fee_rate, exit_slippage_rate, min_reward_risk};
  const invalid = { ...inputs, ok:false, reason:'invalid_entry_economics' };
  if (!['BUY','SELL'].includes(side) || ![entry,stop,target].every(v=>Number.isFinite(v)&&v>0)
    || ![fee_rate,exit_slippage_rate].every(v=>Number.isFinite(v)&&v>=0&&v<=.05)
    || !Number.isFinite(min_reward_risk) || min_reward_risk<1 || min_reward_risk>10) return invalid;
  const sign = side === 'SELL' ? -1 : 1;
  if (sign*(entry-stop)<=0 || sign*(target-entry)<=0) return invalid;
  const target_exit = target*(1-sign*exit_slippage_rate), stop_exit = stop*(1-sign*exit_slippage_rate);
  const reward_per_share = sign*(target_exit-entry)-fee_rate*(entry+target_exit);
  const risk_per_share = sign*(entry-stop_exit)+fee_rate*(entry+stop_exit);
  const reward_risk = reward_per_share/risk_per_share;
  if (![target_exit,stop_exit,reward_per_share,risk_per_share,reward_risk].every(Number.isFinite) || risk_per_share<=0) return invalid;
  const ok = reward_per_share>0 && reward_risk>=min_reward_risk;
  return {...inputs, target_exit, stop_exit, reward_per_share, risk_per_share, reward_risk,
    ok, reason:ok ? null : 'entry_reward_risk_too_low'};
}
