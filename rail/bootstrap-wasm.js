/* P3-1 Rust initialization transport. Returned objects are compatibility views. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const modules=()=>({Core:node?require('./routing-wasm'):root.RailRouting,Wire:node?require('./value-wire'):root.RailValueWire});
function session(op,args){const out=call('session_contract',{protocolVersion:1,op,...args});if(!out.ok)throw Error(out.error.code);return {...out.result,sessionId:out.sessionId,revision:out.revision};}
let workspace;function call(name,value){const{Core,Wire}=modules();workspace||=Core.createWorkspace();const packet=Wire.encodePacked(value);return Wire.decodePacked(workspace.kernel(name==='bootstrap_run'?'bootstrap_packed':'session_packed',packet.values,packet.bytes)).value;}
function forecastExport(id,flowOnly=false){const{Core,Wire}=modules();workspace||=Core.createWorkspace();const packet=workspace.kernel('forecast_numeric_export',Float64Array.of(id,+flowOnly),new Uint8Array(0)),split=1+packet.values[0],dto=Wire.decodePacked({values:packet.values.subarray(1,split),bytes:packet.bytes}).value;if(dto.error)throw Error(dto.error);const tail=packet.values.subarray(split);dto.flowData=tail.subarray(0,dto.flowLength);dto.contractData=tail.subarray(dto.flowLength);delete dto.flowLength;return dto;}
function forecastBulk(action,args,values){const{Core,Wire}=modules();workspace||=Core.createWorkspace();const packet=Wire.encodePacked({action,...args}),frame=new Float64Array(1+packet.values.length+values.length);frame[0]=packet.values.length;frame.set(packet.values,1);frame.set(values,1+packet.values.length);const out=Wire.decodePacked(workspace.kernel('forecast_numeric',frame,packet.bytes)).value;if(out?.error)throw Error(out.error);return out;}
function run(op,args={}){const out=call('bootstrap_run',{op,...args});if(out?.error)throw Error(out.error);return out;}
function readonly(v){if(!v||typeof v!=='object'||ArrayBuffer.isView(v)||Object.isFrozen(v))return v;for(const d of Object.values(Object.getOwnPropertyDescriptors(v)))if(Object.hasOwn(d,'value'))readonly(d.value);return Object.freeze(v);}
let settingsValue;const settings=()=>settingsValue||(settingsValue=readonly(run('settings')));
const views=new Map(),geoViews=new WeakMap();function view(op,region='tokyo'){const key=op+':'+region;if(!views.has(key)){const value=run(op,{region});if(op==='hubs')readonly(value);views.set(key,value);if(op==='city')geoViews.set(value,region);}return views.get(key);}
function runtimeCall(action,args){
 const out=call('session_contract',{protocolVersion:1,op:'runtime',action,...args});
 if(!out.ok)throw Error(out.error.code);
 return out.result;
}
function runtime(action,args={}){
 if(action==='create' && args.saved){
  const field=Array.isArray(args.saved.urbanDefs)?'urbanDefs':'defs';
  const rows=args.saved[field];
  if(Array.isArray(rows) && rows.length>2048){
   const saved={...args.saved, [field]:[]};
   const id=runtimeCall('restoreBegin',{...args,saved,count:rows.length});
   try {
    for(let offset=0;offset<rows.length;offset+=1024)
     runtimeCall('restorePage',{id,offset,rows:rows.slice(offset,offset+1024)});
    return runtimeCall('restoreFinish',{id});
   } catch(error) {
    try { runtimeCall('restoreCancel',{id}); } catch {}
    throw error;
   }
  }
 }
 const paged=action==='snapshot'||action==='handoff'||action==='advanceAll';
 const result=runtimeCall(action,paged?{...args,paged:true}:args);
 if(!result?.pagedSnapshot)return result;
 const rt=result.runtime;
 function read(field,key,append){
  let offset=0;
  do{
   const page=runtimeCall('snapshotPage',{id:args.id,field,key,offset});
   for(const row of page.rows)append(row);
   offset=page.next;
  }while(offset!==null);
 }
 rt.defs=[];read('defs',null,row=>rt.defs.push(row));
 rt.transfers=[];read('transfers',null,row=>rt.transfers.push(row));
 for(const [field,ages] of [['queues','waitSince'],['outside','outsideSince']]){
  rt[field]={};rt[ages]={};
  for(const key of Object.keys(rt.nativeView[field])){
   const bucket=rt[field][key]={};
   read(field,key,([token,amount,since])=>{
    bucket[token]=amount;
    if(since!==null)rt[ages][key+'#'+token]=since;
   });
  }
 }
 for(const train of rt.trains){
  train.passengers={};read('passengers',train.id,([token,amount])=>{train.passengers[token]=amount;});
 }
 delete result.pagedSnapshot;
 return result;
}
const api={platform:(action,args={})=>{const out=call('session_contract',{protocolVersion:1,op:'platform',action,...args});if(!out.ok)throw Error(out.error.code);return out.result;},viewModel:(kind,args={})=>{const out=call('session_contract',{protocolVersion:1,op:'viewModel',kind,...args});if(!out.ok)throw Error(out.error.code);return readonly(out.result);},persistence:(action,args={})=>{const out=call('session_contract',{protocolVersion:1,op:'persistence',action,...args});if(!out.ok)throw Error(out.error.code);return out.result;},legacyOperations:(action,args={})=>{const out=call('session_contract',{protocolVersion:1,op:'legacyOperations',action,args});if(!out.ok)throw Error(out.error.code);return out.result;},compat:(action,args={},state={})=>{const out=call('session_contract',{protocolVersion:1,op:'compat',action,args,state});if(!out.ok)throw Error(out.error.code);return out.result;},runtime,clock:(action,args={})=>{const out=call('session_contract',{protocolVersion:1,op:'clock',action,...args});if(!out.ok)throw Error(out.error.code);return out.result;},forecastExport,forecastBulk,forecast:(action,args={})=>{const out=call('session_contract',{protocolVersion:1,op:'forecast',action,...args});if(!out.ok)throw Error(out.error.code);return out.result;},run,settings,view,readonly,prepareStart:args=>session('prepare_start',args),commitStart:token=>session('commit_start',{token}),cancelStart:token=>session('cancel_start',{token}),geo:base=>geoViews.has(base)?{geoId:geoViews.get(base)}:{base},start:args=>{const out=call('session_contract',{protocolVersion:1,op:'start',...args});if(!out.ok)throw Error(out.error.code);return {...out.result,sessionId:out.sessionId,revision:out.revision};},query:args=>call('session_contract',{protocolVersion:1,op:'query',...args}),decode:text=>api.persistence('decode',{text}),memoryBytes:()=>workspace?.memoryBytes()||0,ensure:()=>{const{Core,Wire}=modules();if(!Core.editorReady())Core.kernel('bootstrap_run',Wire.encode({op:'installConfig'}));}};
if(node)module.exports=api;else root.RailBootstrap=api;
})(typeof globalThis!=='undefined'?globalThis:this);
