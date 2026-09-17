/** Pure candle analytics shared by serial research and isolated CPU workers. */
import {intraday_signal,swing_signal,daily_holding_exit,technical_exit} from './strategy.js';

export function evaluateComparisonTask(task,strategyOptions={}) {
  const position=task.position?{...task.position}:null;
  let daily=null,technical=null,signal=null,reason=null;
  if(position){
    if(task.strategy==='swing'){
      daily=daily_holding_exit(task.history,position,strategyOptions);
      if(daily){
        if(Number.isFinite(daily.trailing_stop)&&daily.trailing_stop>0)position.stop=position.trailing_stop=Math.max(position.stop,daily.trailing_stop);
        if(daily.trend_exit)position.pending_exit='daily_trend_loss';
      }
    }
    technical=technical_exit(task.history,position,strategyOptions,task.context);
  }
  if(task.signal)[signal,reason]=(task.strategy==='intraday'?intraday_signal:swing_signal)(task.history,strategyOptions,task.context);
  return {daily,technical,signal,reason};
}
