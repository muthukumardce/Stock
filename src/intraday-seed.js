/** Valid observed candles for indicator warmup, not an official closing price.
 * From 2026-08-03, Kite's CAS-stock history ends at 15:15 (last 5m bar 15:10):
 * https://kite.trade/forum/discussion/16171/historical-data-api-missing-minute-candles-after-15-14
 * The 72-bar shape is accepted only as an indicator seed. It does not establish
 * CAS eligibility or provide the auction close needed for opening-gap signals.
 */
import {validate_bars} from './indicators.js';
import {parseTime,dateIST,timeIST} from './util.js';

export function validPreviousIntradaySeed(rows,today) {
  if(!Array.isArray(rows)||rows.length<34||!validate_bars(rows,{interval:'intraday'}).valid)return false;
  const last=parseTime(rows.at(-1).time??rows.at(-1).date),priorDay=dateIST(last);
  const current=parseTime(today+'T00:00:00+05:30');
  if(!current||dateIST(current)!==today)return false;
  const age=current-parseTime(priorDay+'T00:00:00+05:30');
  if(priorDay>=today||!Number.isFinite(age)||age>7*86400000)return false;
  if(timeIST(last)==='15:25')return true;
  return priorDay>='2026-08-03'&&timeIST(last)==='15:10'&&rows.length===72
    &&timeIST(parseTime(rows[0].time??rows[0].date))==='09:15';
}
