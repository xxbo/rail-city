/* Read-only native cultivation/record facade. Mutable compatibility helpers
   are development-only and excluded from the browser dependency closure. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap, VM=()=>node?require('./view-model'):root.RailViewModel;
const query=(kind,args)=>VM().query(kind,args);
const api={day:minute=>query('day',{minute}),line:(state,target)=>query('line',{state:{ridership:state.ridership},target}),
 limits:(state,target)=>query('limits',{state,target}),station:(state,target,minute=state.economy?.minute||420)=>query('station',{state:{ridership:state.ridership},target,minute}),
 factor:(state,journey)=>query('factor',{state:{ridership:state.ridership},journey}),multiplier:score=>query('multiplier',{score}),
 awards:records=>query('awards',{records}),mergeRecords:(a={},b={})=>B().persistence('mergeRecords',{values:[a,b]}),
 get WEIGHTS(){return query('weights');},get LABELS(){return VM().labels;},
 RECORD_FIELDS:Object.freeze(['bestDay','bestHour','totalCompleted','totalPassengerKm','bestNetworkKm','bestLineKm','bestRevenue'])};
if(node)module.exports=Object.defineProperties({...require('../scripts/fixtures/rail-p3-8-ridership.cjs')},Object.getOwnPropertyDescriptors(api));else root.RailRidership=api;
})(typeof globalThis!=='undefined'?globalThis:this);
