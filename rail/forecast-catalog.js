/* P3-2 handle transport. Tables, indexes, mutations and view eviction live in Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const bootstrap=()=>node?require('./bootstrap-wasm'):root.RailBootstrap;
const forecasts=new WeakMap(),catalogs=new WeakMap(),diagnosticTokens=new WeakMap(),dailyListeners=new WeakMap();
const invoke=(action,args={})=>bootstrap().forecast(action,args);
const released=typeof FinalizationRegistry==='function'?new FinalizationRegistry(id=>{try{invoke('release',{id});}catch{}}):null;
function lease(descriptor){const handle=Object.freeze(descriptor);released?.register(handle,handle.id);return handle;}
function readonly(v){return bootstrap().readonly(v);}
function query(handle,action,args={}){return invoke(action,{id:handle.id,...args});}
function lazy(handle,view){let pageStart=-1,pageRows;const target=new Array(handle.count);const index=k=>typeof k==='string'&&/^(0|[1-9]\d*)$/.test(k)&&+k<handle.count?+k:-1;
 return new Proxy(target,{has:(t,k)=>index(k)>=0||Reflect.has(t,k),set:()=>false,deleteProperty:()=>false,get(t,k,r){const i=index(k);if(i<0)return Reflect.get(t,k,r);let row;if(view==='flow'){const start=Math.floor(i/256)*256;if(start!==pageStart){pageRows=query(handle,'page',{start,count:256,view});pageStart=start;}row=pageRows[i-pageStart];}else row=query(handle,view,{index:i});if(view==='definition')Object.defineProperty(row,'daily',{enumerable:true,configurable:false,get:()=>query(handle,'daily',{index:i})});return readonly(row);}});
}
function bind(base,descriptor){const handle=lease(descriptor),flows=lazy(handle,'flow'),defs=lazy(handle,'definition');catalogs.set(defs,handle);base.flows=flows;base.preparedDefinitions=defs;forecasts.set(base,handle);return base;}
function definitions(base){const handle=forecasts.get(base);if(!handle)return null;const result=lazy(handle,'definition');catalogs.set(result,handle);return result;}
function attach(base,dto){const flow=dto.flowData,contracts=dto.contractData,data=new Float64Array(flow.length+(contracts?.length||0));data.set(flow);if(contracts)data.set(contracts,flow.length);const{flowData,contractData,...metadata}=dto;return bind(base,bootstrap().forecastBulk('attach',{dto:metadata,hasContracts:!!contracts},data));}
function attachOutput(base,dto,tail,preserve=false){const handle=bootstrap().forecastBulk('attachOutput',{dto},tail);if(preserve)forecasts.set(base,lease(handle));else bind(base,handle);return handle;}
function transport(base){const handle=forecasts.get(base);if(!handle)return base;const result={...base,compactForecast:bootstrap().forecastExport(handle.id)};delete result.flows;delete result.preparedDefinitions;return result;}
function hydrate(base){if(!base.compactForecast)return base;const dto=base.compactForecast;delete base.compactForecast;return seal(attach(base,dto));}
function seal(base){if(!forecasts.has(base))return base;for(const key of Object.keys(base)){if(key==='preparedDefinitions')continue;readonly(base[key]);Object.defineProperty(base,key,{writable:false,configurable:false});}return base;}
function select(catalog,indices){const handle=catalogs.get(catalog);if(!handle)return indices.map(i=>catalog[i]);return bind({},query(handle,'select',{indices})).preparedDefinitions;}
function profile(catalog,index){return query(catalogs.get(catalog),'profile',{index});}
function daily(catalog,index){return query(catalogs.get(catalog),'daily',{index});}
function setDaily(catalog,index,value){const handle=catalogs.get(catalog),revision=query(handle,'setDaily',{index,value});for(const listener of dailyListeners.get(handle)||[])listener(index,value,revision);return revision;}
function onDaily(catalog,listener){const handle=catalogs.get(catalog);let listeners=dailyListeners.get(handle);if(!listeners)dailyListeners.set(handle,listeners=new Set());listeners.add(listener);return()=>listeners.delete(listener);}
function dailyPatch(catalog,after=0,load=false){return query(catalogs.get(catalog),'dailyPatch',{after,load});}
function totals(catalog){return query(catalogs.get(catalog),'totals');}
function legs(catalog,index){return query(catalogs.get(catalog),'legs',{index});}
function page(base,start=0,count=256,view='flow'){const handle=forecasts.get(base)||catalogs.get(base);return readonly(query(handle,'page',{start,count,view}));}
function summary(base,state){const handle=forecasts.get(base);return handle?query(handle,'summary',{ridership:state.ridership?{model:state.ridership.model,lines:state.ridership.lines}:undefined}):null;}
function connections(base,state){const handle=forecasts.get(base);return handle?query(handle,'connections',{services:state.services,stations:base.catchment.stations}):null;}
function diagnostic(base){const handle=forecasts.get(base);if(!handle)return null;const Core=node?require('./routing-wasm'):root.RailRouting;let token=diagnosticTokens.get(handle);if(token&&Core.diagnosticToken()===token)return{token};const dto=bootstrap().forecastExport(handle.id,true);if(!token){token=Core.allocateToken();diagnosticTokens.set(handle,token);}return{token,meta:{graph:dto.graph,count:dto.count,compact:true,population:base.population,covered:base.catchment?.covered},data:dto.flowData};}

function sampling(catalog){return query(catalogs.get(catalog),'sampling');}
function attachLegacy(base,state){let handle;
 if(Array.isArray(base.preparedDefinitions)&&base.preparedDefinitions.length>2048){const id=invoke('legacyBegin',{state});try{for(let at=0;at<base.preparedDefinitions.length;at+=2048)invoke('legacyAppend',{id,rows:base.preparedDefinitions.slice(at,at+2048)});handle=invoke('legacyFinish',{id});}catch(error){invoke('legacyCancel',{id});throw error;}}
 else handle=invoke('attachLegacy',{state,forecast:{flows:base.flows,preparedDefinitions:base.preparedDefinitions}});
 const owned=lease(handle);forecasts.set(base,owned);return owned;
}

const api={adopt:(base,descriptor,project=false)=>{if(project)return bind(base,descriptor);forecasts.set(base,lease(descriptor));return base;},attachLegacy,onDaily,definitions,seal,key:journey=>invoke('journeyKey',{journey}),attach,attachOutput,transport,hydrate,select,profile,daily,setDaily,dailyPatch,totals,legs,page,summary,connections,diagnostic,sampling,
 source:base=>forecasts.get(base),meta:catalog=>catalogs.get(catalog),status:base=>{const handle=forecasts.get(base);return handle?query(handle,'status'):null;}};
if(node)module.exports=api;else root.RailForecastCatalog=api;
})(typeof globalThis!=='undefined'?globalThis:this);
