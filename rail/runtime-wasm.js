/* Session runtime binding. Rust owns simulation; objects below are detached display/save views. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap,C=()=>node?require('./forecast-catalog'):root.RailForecastCatalog;
const entries=new WeakMap(),released=typeof FinalizationRegistry==='function'?new FinalizationRegistry(id=>{try{B().runtime('close',{id});}catch{}}):null;
function sync(target,value){if(Array.isArray(value)){const old=new Map((Array.isArray(target)?target:[]).filter(v=>v&&typeof v==='object'&&v.id!==undefined).map(v=>[v.id,v]));return value.map((v,i)=>sync(v?.id!==undefined?old.get(v.id):target?.[i],v));}if(value&&typeof value==='object'){const out=target&&typeof target==='object'&&!Array.isArray(target)?target:{};for(const k of Object.keys(out))if(!Object.hasOwn(value,k))delete out[k];for(const[k,v]of Object.entries(value))out[k]=sync(out[k],v);return out;}return value;}
function apply(entry,result){if(result.clock)entry.rt.nativeClock=B().readonly(result.clock);if(result.error)throw Error(result.error);if(result.editRevision!==undefined)entry.editRevision=result.editRevision;if(result.worldPatch)for(const[k,v]of Object.entries(result.worldPatch))entry.world[k]=sync(entry.world[k],v);if(result.runtime){for(const[k,v]of Object.entries(result.runtime))entry.rt[k]=sync(entry.rt[k],v);if(!result.runtime.nativeView)delete entry.rt.nativeView;}return result;}
// A save DTO is returned to its caller, while the live UI keeps only compact
// views. Explicit materializeAsync still requests a complete inspection view.
function applySnapshot(entry,result){if(!result.runtime)return apply(entry,result);const{defs,queues,outside,waitSince,outsideSince,transfers,...display}=result.runtime;display.trains=display.trains.map(({passengers,...train})=>({...train,passengers:{}}));Object.assign(display,{queues:{},outside:{},waitSince:{},outsideSince:{},transfers:[]});apply(entry,{...result,runtime:display});return result;}
function supports(world,forecast){return !!forecast&&(!!C().source(forecast)||Array.isArray(forecast.flows));}
function create(world,forecast,start=420,warm=true,saved,initial){const handle=C().source(forecast)||C().attachLegacy(forecast,world);const result=B().runtime('create',{world,catalog:handle.id,start,warm,saved,...(initial===undefined?{}:{initial}),forecastView:{population:forecast.population,covered:forecast.catchment?.covered||0}});const rt={};const entry={rt,world,forecast,id:result.id,worker:null,commandSerial:result.runtime?.nativeCommandSerial||0,editRevision:result.editRevision||0,tail:Promise.resolve(),closed:false};entries.set(rt,entry);released?.register(rt,entry.id,rt);Object.defineProperty(rt,'demandCatalog',{value:C().definitions(forecast),writable:true,configurable:true});applySnapshot(entry,result);if(!node)worker(entry);return rt;}
function worker(entry){if(entry.worker||entry.localOnly||entry.disposed)return;const snapshot=B().runtime('handoff',{id:entry.id});
 const Client=node?require('./worker-client'):root.RailWorkerClient;
 entry.worker=Client.create({stateful:true,timeout:45000,timeoutMessage:'运行会话响应超时，进度等待恢复。',errorMessage:'运行线程异常',
  createWorker:()=>node?new (require('node:worker_threads').Worker)(require('node:path').join(__dirname,'simulation-worker.js')):new Worker(new URL('simulation-worker.js?v=75',root.location.href)),
  onFault:error=>{entry.closed=true;entry.failure=error;}});
 async function startWorker() {
  const forecast=C().runtimePacket(entry.forecast);
  const result=await send(entry,'create',{world:snapshot.world,forecast,saved:snapshot.runtime,start:snapshot.runtime.minute,warm:false});
  entry.workerId=result.id;
  if(!entry.mainClosed) {
   B().runtime('close',{id:entry.id});
   entry.mainClosed=true;
   released?.unregister(entry.rt);
  }
  return apply(entry,result);
 }
 entry.ready=startWorker().catch(error=>{
  if(entry.disposed||entry.mainClosed)throw error;
  entry.worker.dispose();
  entry.worker=null;
  entry.localOnly=true;
  entry.workerError=error;
  entry.failure=null;
  entry.closed=false;
 });
 entry.ready.catch(()=>{});
}
async function send(entry,action,args) {
 const packet=args.forecast;
 try {
  const message=await entry.worker.request({kind:'session',action,args},C().transfers(packet));
  return message.result;
 }catch(error){
  C().cancelPort(packet?.compactForecast?.port);
  throw error;
 }
}
function enqueue(entry,action,args={},project=apply) {
 const task=entry.tail.then(async()=>{
  if(entry.worker)await entry.ready;
  if(entry.closed)throw entry.failure||Error('运行会话已关闭');
  if(['command','preview','demand','undo'].includes(action)&&args.expectedEditRevision===undefined)
   args={...args,expectedEditRevision:entry.editRevision};
  if(['demand','prepareImport'].includes(action)&&args.forecast) {
   const {forecast,...rest}=args;
   if(entry.worker)args={...rest,forecast:C().runtimePacket(forecast)};
   else {
    const handle=await C().localCatalog(forecast);
    if(entry.closed)throw entry.failure||Error('运行会话已关闭');
    args={...rest,catalog:handle.id,forecastView:{population:forecast.population,covered:forecast.catchment?.covered||0}};
   }
  }
  const result=entry.worker ? await send(entry,action,{id:entry.workerId,...args})
                            : B().runtime(action,{id:entry.id,...args});
  return project(entry,result);
 });
 entry.tail=task.then(()=>{},()=>{});
 return task;
}
function advance(world,rt,minutes,options={}){const entry=entries.get(rt);if(entry.worker)throw Error('运行线程会话使用异步推进接口');return apply(entry,B().runtime(options.full?'advanceAll':'advance',{id:entry.id,minutes,budget:options.budget??1e9,maxSteps:options.maxSteps??10000})).batch;}
function advanceAsync(world,rt,minutes,options={}){const entry=entries.get(rt);if(options.worker!==false)worker(entry);return enqueue(entry,'advance',{minutes,budget:options.budget??6,maxSteps:options.maxSteps??100}).then(result=>result.batch);}
function pulse(world,rt,intent){const entry=entries.get(rt);if(entry.closed&&entry.mainClosed)return Promise.reject(entry.failure||Error('运行会话已关闭'));worker(entry);return Promise.resolve(entry.ready).then(()=>{if(entry.closed)throw entry.failure||Error('运行会话已关闭');if(entry.worker&&!entry.worker.offer())return{clock:rt.nativeClock};return enqueue(entry,'pulse',intent);});}

function intent(rt,value){const entry=entries.get(rt);return entry?enqueue(entry,'intent',value):Promise.resolve();}
function savedView(out){const{plan,nativeView,defs,...saved}=out;if(plan?.urban)saved.urbanDefs=defs;else if(defs)saved.urbanDefs=defs;return saved;}
function snapshot(rt){const entry=entries.get(rt);if(entry.worker)throw Error('运行线程存档使用异步快照接口');const out=applySnapshot(entry,B().runtime('snapshot',{id:entry.id})).runtime;return savedView(out);}
function snapshotAsync(rt){const entry=entries.get(rt);return enqueue(entry,'snapshot',{},applySnapshot).then(result=>{return savedView(result.runtime);});}
function dispose(rt){const entry=entries.get(rt);if(!entry)return;released?.unregister(rt);entry.unsubscribe?.();entry.disposed=true;entry.closed=true;if(entry.worker)entry.worker.dispose();if(!entry.mainClosed){B().runtime('close',{id:entry.id});entry.mainClosed=true;}entries.delete(rt);}
function rebind(rt,world,forecast){const entry=entries.get(rt);if(!entry)return rt;if(entry.worker)throw Error('运行线程会话请使用异步原生编辑或恢复接口');const saved=snapshot(rt),replacement=create(world,forecast,saved.minute,false,saved),next=entries.get(replacement);dispose(rt);entries.delete(replacement);released?.unregister(replacement);if(!next.mainClosed)released?.register(rt,next.id,rt);for(const[k,v]of Object.entries(replacement))rt[k]=sync(rt[k],v);Object.defineProperty(rt,'demandCatalog',{value:replacement.demandCatalog,writable:true,configurable:true});next.rt=rt;entries.set(rt,next);return rt;}
function commandSync(rt,command,undo=false){const entry=entries.get(rt);if(!entry||entry.closed)throw Error('运行会话已关闭');if(entry.worker)throw Error('运行线程会话使用异步编辑接口');return apply(entry,B().runtime('command',{id:entry.id,command,undo,commandId:++entry.commandSerial,expectedEditRevision:entry.editRevision}));}
function transaction(rt,action,args={}){const entry=entries.get(rt);worker(entry);return enqueue(entry,action,{...args,...(action==='preview'?{}:{commandId:++entry.commandSerial})});}
function replaceDemandSync(rt,forecast){const entry=entries.get(rt);if(entry.worker)throw Error('运行线程会话使用异步需求接口');const source=C().source(forecast)||C().attachLegacy(forecast,entry.world);const result=apply(entry,B().runtime('demand',{id:entry.id,catalog:source.id,expectedEditRevision:entry.editRevision,commandId:++entry.commandSerial,forecastView:{population:forecast.population,covered:forecast.catchment?.covered||0}}));entry.forecast=forecast;rt.demandCatalog=C().definitions(forecast);apply(entry,B().runtime('snapshot',{id:entry.id}));return result;}
function replaceDemand(rt,forecast,expectedEditRevision,forecastTicket){const entry=entries.get(rt);if(!C().source(forecast))C().attachLegacy(forecast,entry.world);return transaction(rt,'demand',{forecast,expectedEditRevision,...(forecastTicket===undefined?{}:{forecastTicket})}).then(result=>{entry.forecast=forecast;rt.demandCatalog=C().definitions(forecast);return result;});}
function request(rt,action,args={}){const entry=entries.get(rt);worker(entry);return enqueue(entry,action,args);}
function setDaily(rt,index,value){const entry=entries.get(rt),forecast=entry.forecast;return request(rt,'setDaily',{index,value}).then(result=>{if(entry.worker)C().setDaily(C().definitions(forecast),index,value);return result;});}
const api={dispatchRecommendation:(rt,lineId,stations)=>request(rt,'dispatchRecommendation',{lineId,stations}),checkpoint:(rt,settings={})=>request(rt,'checkpoint',{settings,at:Date.now()}),previewImport:(rt,text)=>request(rt,'previewImport',{text}).then(out=>out.preview),prepareImport:(rt,token,forecast,args={})=>request(rt,'prepareImport',{token,forecast,...args,at:Date.now()}),cancelImport:(rt,token)=>request(rt,'importCancel',{token}),commitImport:(rt,token)=>request(rt,'importCommitted',{token}),query:(rt,query,target)=>request(rt,'query',{query,target}).then(out=>out.projection),querySync:(rt,query,target)=>{const entry=entries.get(rt);if(entry.worker)throw Error('运行线程查询使用异步接口');return B().runtime('query',{id:entry.id,query,target}).projection;},setDaily,forecastInvalidate:rt=>request(rt,'forecastInvalidate'),forecastBegin:(rt,blocked=false)=>request(rt,'forecastBegin',{blocked}),forecastFinish:(rt,ticket,success)=>enqueue(entries.get(rt),'forecastFinish',{ticket,success}),diagnose:(rt,query)=>request(rt,'diagnose',{query}),observe:(rt,eventId)=>request(rt,'observe',{eventId}),forecastQuery:(rt,query,args={})=>request(rt,'forecastQuery',{query,...args}),commandSync,command:(rt,command,undo=false)=>transaction(rt,'command',{command,undo}),preview:(rt,command)=>transaction(rt,'preview',{command}),undo:(rt,undoToken)=>transaction(rt,'undo',{undoToken}),replaceDemandSync,replaceDemand,editRevision:rt=>entries.get(rt)?.editRevision,credit:(rt,args)=>enqueue(entries.get(rt),'credit',args).then(result=>result.credit),usesWorker:rt=>!!entries.get(rt)?.worker,supports,create,has:rt=>entries.has(rt),advance,advanceAsync,pulse,intent,snapshot,snapshotAsync,materializeAsync:rt=>enqueue(entries.get(rt),'snapshot').then(()=>rt),dispose,rebind,syncBank:(world,rt)=>enqueue(entries.get(rt),'syncBank',{economy:world.economy}),idle:rt=>entries.get(rt)?.tail||Promise.resolve(),isBusy:rt=>!!entries.get(rt)?.worker?.pending};
if(node)module.exports=api;else root.RailRuntime=api;
})(typeof globalThis!=='undefined'?globalThis:this);
