import {isoIST} from './util.js';

// Keep deployment authority narrower than the settings form or worker result.
export const TUNABLE_KEYS=Object.freeze(['min_signal_score','min_adx','min_setup_volume','max_atr_extension']);

export function createResearchApplier({settings,manager,engine,store,canApply=()=>true,now=()=>new Date()}){
  return async({parameters,isCurrent,source='automatic'})=>{
    if(!['automatic','manual'].includes(source))return {status:'not_applied',reason:'Unknown parameter application source.'};
    if(source==='automatic'&&!settings.research_tuning_apply)return {status:'disabled',reason:'Automatic parameter application is disabled in Settings.'};
    if(!manager||!engine._lock?.run||typeof engine._invalidate_decisions!=='function')return {status:'not_applied',reason:'Automatic parameter application is unavailable in this runtime.'};
    if(!parameters||Array.isArray(parameters)||!Object.keys(parameters).length||Object.entries(parameters).some(([key,value])=>!TUNABLE_KEYS.includes(key)||!Number.isFinite(value)))return {status:'not_applied',reason:'The candidate contains unsupported parameter changes.'};
    return engine._lock.run(()=>{
      if(!canApply()||!isCurrent())return {status:'stale',reason:'The research context changed before parameters could be applied.'};
      if(!engine.connected||engine._shutdown)return {status:'waiting',reason:'Waiting for a connected account before applying selected parameters.'};
      const view=engine.snapshot();
      if(view.positions?.length||view.pending_orders?.length||view.unmanaged_live_exposure||engine._unresolved_intents?.())return {status:'waiting',reason:'Waiting for managed positions and pending orders to finish before changing strategy parameters.'};
      const changes=Object.entries(parameters).filter(([key,value])=>settings[key]!==value).map(([key,after])=>({key,before:settings[key],after}));
      if(!changes.length)return {status:'not_applied',reason:'These parameter values are already active.'};
      manager.candidate(parameters); // Validate before writing or invalidating analysis.
      const applied_at=isoIST(now());
      store.event('research.parameters_applying','Applying '+(source==='manual'?'user-selected':'validated')+' strategy parameters; execution mode and risk limits stay in force.',{changes,source,mode:settings.trading_mode,applied_at});
      manager.save(parameters);
      Object.assign(settings,parameters);
      engine._invalidate_decisions();
      const application={status:'applied',source,reason:(source==='manual'?'User-selected':'Validated')+' parameters saved for subsequent paper and live trading decisions.',changes,applied_at};
      store.event('research.parameters_applied',application.reason,{changes,source,mode:settings.trading_mode,applied_at});
      return application;
    });
  };
}
