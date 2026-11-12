/* Native passenger arenas. Cohorts, identities, migration and weighted/integer modes belong to Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,Runtime=node?require('./runtime-wasm'):root.RailRuntime,B=node?require('./operations'):root.RailOperations,Catalog=node?require('./forecast-catalog'):root.RailForecastCatalog;
const details=new WeakMap();
function create(s,forecast,start=420,warm=true,initial){return Runtime.create(s,forecast,start,warm,undefined,initial);}
function restore(s,forecast,saved){try{return Runtime.create(s,forecast,saved.minute,false,saved);}catch{return null;}}
function definitions(s,forecast){if(!Catalog.source(forecast))Catalog.attachLegacy(forecast,s);return Catalog.definitions(forecast);}
function summary(rt){if(node&&!Runtime.usesWorker(rt))return Runtime.querySync(rt,'summary');return {active:rt.trains.length,...rt.nativeView?.summary,completed:rt.completed,cancelled:rt.cancelled,generated:rt.generated,revenue:rt.revenue};}
function station(rt,id){if(node&&!Runtime.usesWorker(rt))return Runtime.querySync(rt,'station',id);const cached=details.get(rt)?.get(id);if(cached&&cached.minute===rt.minute&&cached.edit===Runtime.editRevision(rt))return cached.projection;return {waiting:rt.nativeView?.stations?.[id]||0,outside:rt.nativeView?.outside?.[id]?.total||0,...rt.stationLimits?.[id],transferring:0,lines:{},destinations:{},purposes:{work:0,shopping:0,leisure:0},today:{entered:0,boarded:0,alighted:0}};}
async function detailsAsync(rt,kind,id){const projection=await Runtime.query(rt,kind,id);if(kind==='station'){let cache=details.get(rt);if(!cache)details.set(rt,cache=new Map());cache.set(id,{projection,minute:rt.minute,edit:Runtime.editRevision(rt)});}return projection;}
const api={create,restore,definitions,advance:(rt,s,minutes)=>{Runtime.advance(s,rt,minutes,{full:true});return rt;},advanceTick:(rt,s,dt)=>{Runtime.advance(s,rt,dt);return rt;},advanceTickAsync:(rt,s,dt)=>Runtime.advanceAsync(s,rt,dt).then(()=>rt),continueRun:(rt,s,minutes,options)=>Runtime.advance(s,rt,minutes,options),continueAsync:(rt,s,minutes,options)=>Runtime.advanceAsync(s,rt,minutes,options),
 reconcile:()=>{throw Error('请通过原生会话提交结构化编辑命令。');},rebase:(rt,s,forecast)=>node&&!Runtime.usesWorker(rt)?Runtime.replaceDemandSync(rt,forecast):Runtime.replaceDemand(rt,forecast),dispose:rt=>{details.delete(rt);Runtime.dispose(rt);},summary,station,detailsAsync,
 snapshot:Runtime.snapshot,snapshotAsync:Runtime.snapshotAsync,materializeAsync:Runtime.materializeAsync,historyAsync:rt=>Runtime.query(rt,'history'),nativeViews:rt=>!!rt.nativeView,
 demandSummary:rt=>({...rt.demandStatus,storedProfiles:rt.storedProfiles,lazy:true}),setDaily:(rt,index,value)=>Runtime.setDaily(rt,index,value),MAX_SAVED_DEFINITIONS:300000,
 position:(s,t,scale)=>B.position(t.retiringKey&&s.routeArchives?.[t.retiringKey]?{...s,tracks:s.routeArchives[t.retiringKey].tracks}:s,t,scale)};
if(node)module.exports=api;else root.RailPassengers=api;
})(typeof globalThis!=='undefined'?globalThis:this);
