/* Cold save transport. Native rules accept/version/validate; browser owns JSON and files. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
function run(op,args={}){const Editor=node?require('./editor-wasm'):root.RailEditor,TX=node?require('./transactions-wasm'):root.RailTransactions;Editor.ensure();
if(op==='signature'){const s=args.state;args={state:{region:s.region,routeModel:s.routeModel,services:s.services,depot:s.depot,urban:s.urban?{version:s.urban.version,revision:s.urban.revision}:null,tracks:s.tracks}};}
if(op==='restore'){const s=args.state,{urbanDefs,...saved}=args.saved||{},catalog=s.urban&&urbanDefs?urbanDefs:args.defs;args={state:{routeModel:s.routeModel,services:s.services,baseLines:s.baseLines,nodes:s.nodes.map(Boolean),urban:s.urban?{}:null},saved:{...saved,hasUrbanDefs:!!(s.urban&&urbanDefs)},defs:catalog.map(j=>[j.id,j.daily,j.fare,j.legs.map(e=>[e.service,e.dir,e.from,e.to])]),plan:{services:args.plan.services,tracks:args.plan.tracks}};}
if(op==='definitions')args={...args,plan:{services:args.plan.services.map(l=>({id:l.id,stops:l.stops,trackIds:l.trackIds}))}};
if(op==='catalogValid')args={value:args.value.map(j=>[j.daily,j.fare,j.legs?.length])};
if(op==='legacyDispatch'){const s=args.state;args={...args,state:{routeModel:s.routeModel,operatingPlan:s.operatingPlan,services:s.services,tracks:s.tracks}};}
if(op==='checkpoint'&&args.value?.runtime){const v=args.value,{urbanDefs,...runtime}=v.runtime;args={...args,value:{...v,runtime}};}
if(op==='accept'){const Wire=node?require('./value-wire'):root.RailValueWire,v=args.value;let value=v;if(v&&typeof v==='object'&&!Array.isArray(v)){const keys=['format','formatVersion','runtimeVersion','gameVersion','region','state','signature','runtime'];value=Object.fromEntries(keys.filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]]));if(v.runtime&&typeof v.runtime==='object'&&Array.isArray(v.runtime.urbanDefs)){value.runtime={...v.runtime,urbanDefs:v.runtime.urbanDefs.map(j=>[j?.id,j?.daily,j?.fare,Array.isArray(j?.legs)?j.legs.map(e=>[e?.service,e?.dir,e?.from,e?.to]):j?.legs])};}}args={value,structure:Wire.inspect(v)};}
return TX.run(50,{op,...args});}
const api={run};if(node)module.exports=api;else root.RailSave=api;
})(typeof globalThis!=='undefined'?globalThis:this);
