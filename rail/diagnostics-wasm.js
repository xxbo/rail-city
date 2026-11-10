/* Native diagnostic transport, standard codecs and UI projections. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const Core=node?require('./routing-wasm'):root.RailRouting,Wire=node?require('./value-wire'):root.RailValueWire;
const tokens=new WeakMap();
function forecastFrame(f){const Compact=node?require('./forecast-catalog'):root.RailForecastCatalog,dto=Compact?.source(f);
 if(dto){let token=tokens.get(dto);if(!token){token=Core.allocateToken();tokens.set(dto,token);}return {token,meta:{graph:dto.graph,count:dto.count,compact:true,population:f.population,covered:f.catchment?.covered},data:dto.flowData};}
 const graph={lines:[],edges:[]},ids=new Map(),edges=new Map(),data=[];const id=k=>{if(!ids.has(k)){ids.set(k,graph.lines.length);graph.lines.push(k);}return ids.get(k);};const edge=e=>{if(!edges.has(e)){edges.set(e,graph.edges.length);graph.edges.push(e);}return edges.get(e);};
 for(const v of f.flows||[]){data.push(v.from,v.trips,v.demandTrips??v.trips,v.path.km,v.path.transfers,+!!v.hub,v.path.fare);if(v.lineIds){data.push(v.lineIds.length);for(const k of v.lineIds)data.push(id(k));}else data.push(-1);const fares=Object.entries(v.path.fares||{});data.push(fares.length);for(const[k,n]of fares)data.push(id(k),n);data.push((v.path.edges||[]).length);for(const e of v.path.edges||[])data.push(edge(e));}
 return {token:Core.allocateToken(),meta:{graph,count:(f.flows||[]).length,compact:false,population:f.population,covered:f.catchment?.covered},data};
}
function run(s,op,args={},rt={},forecast){const Editor=node?require('./editor-wasm'):root.RailEditor;Editor.ensure();
 const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(v||{},k)).map(k=>[k,v[k]]));
 let state=op==='preview'?Editor.snapshot(s):s;
 if(!op.startsWith('review')&&op!=='preview')state={routeModel:s.routeModel,operatingPlan:s.operatingPlan,services:s.services,baseLines:s.baseLines,tracks:s.tracks?.map(t=>({id:t.id,a:t.a,b:t.b,km:t.km})),nodes:s.nodes?.map(n=>({id:n.id,name:n.name})),depot:s.depot,economy:s.economy,ridership:s.ridership?{model:s.ridership.model,lines:s.ridership.lines}:undefined};
 if(op.startsWith('review')){const q=s.ridership,day=d=>d?{number:d.number,lines:Object.fromEntries(Object.entries(d.lines||{}).map(([id,row])=>[id,pick(row,['boarded','completed','waitMinutes','revenue','operating'])]))}:undefined;state={services:s.services,urban:s.urban?{totals:s.urban.totals}:undefined,operationsReview:s.operationsReview,ridership:q?{current:day(q.current),history:q.history?.map(day),lines:q.lines}:undefined};}
 const runtime={minute:rt.minute,trains:rt.trains?.map(t=>pick(t,['parentLine','service','onboard','capacity']))};
 if(['analyze','diagnose','alerts'].includes(op)){for(const key of ['queues','outside','transfers','nativeView'])if(Object.hasOwn(rt,key))runtime[key]=rt[key];if(op==='alerts'&&rt.plan)runtime.plan=pick(rt.plan,['routeModel','services','tracks','economy']);}
 const f=forecast&&forecastFrame(forecast),load=!!f&&Core.diagnosticToken()!==f.token;
 const metadata=Wire.encode({state,op,args,runtime,forecastView:forecast?{population:forecast.population,covered:forecast.catchment?.covered}:undefined,load,token:f?.token,forecast:load?f.meta:undefined});const input=new Float64Array(1+metadata.length+(load?f.data.length:0));input[0]=metadata.length;input.set(metadata,1);if(load)input.set(f.data,1+metadata.length);
 return Wire.decode(Core.kernel('diagnostic_run',input)).value;
}
// Generic reference-preserving application: live observation event objects stay live.
function sync(target,value){if(Array.isArray(value)){const prior=new Map((Array.isArray(target)?target:[]).filter(v=>v&&typeof v==='object'&&v.id!==undefined).map(v=>[v.id,v]));return value.map((v,i)=>sync(v?.id!==undefined?prior.get(v.id):target?.[i],v));}if(value&&typeof value==='object'){const out=target&&typeof target==='object'&&!Array.isArray(target)?target:{};for(const k of Object.keys(out))if(!Object.hasOwn(value,k))delete out[k];for(const[k,v]of Object.entries(value))out[k]=sync(out[k],v);return out;}return value;}
function review(s,op,args={},rt={}){const out=run(s,'review'+op,args,rt);if(Object.hasOwn(out||{},'review')){if(out.review===undefined)delete s.operationsReview;else s.operationsReview=sync(s.operationsReview,out.review);}if(op==='Init')return s.operationsReview;if(op==='Observe'&&out.result)return s.operationsReview.events.find(e=>e.id===out.result.id);return Object.hasOwn(out||{},'result')?out.result:out;}
const api={run,review};if(node)module.exports=api;else root.RailDiagnostics=api;
})(typeof globalThis!=='undefined'?globalThis:this);
