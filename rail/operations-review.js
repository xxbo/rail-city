/* Native actual observation lifecycle. The host schedules due native timestamps and retains view references. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const native=()=>node?require('./diagnostics-wasm'):root.RailDiagnostics;
const init=(s,rt)=>native().review(s,'Init',{},rt);
function sample(s,rt,force=false){
 if(!s.operationsReview)return false;
 const owner=node?require('./bootstrap-wasm'):root.RailBootstrap;
 if(!owner.viewModel('reviewDue',{minute:rt.minute,nextAt:s.operationsReview.nextAt,force}))return false;
 return native().review(s,'Sample',{force},rt);
}
const prepare=(s,rt)=>native().review(s,'Prepare',{},rt),record=(s,rt,mark)=>native().review(s,'Record',{mark},rt),observe=(s,rt,id)=>native().review(s,'Observe',{id},rt),ready=(s,minute)=>native().review(s,'Ready',{minute}),view=e=>native().review({},'View',{event:e}),rates=a=>native().review({},'Rates',{value:a}),valid=s=>native().review(s,'Valid');
const api={init,sample,prepare,record,observe,ready,view,rates,valid,STEP:5,WINDOW:60,WARMUP:15,MINIMUM:30,LIMIT:20};
if(node)module.exports=api;else root.RailOperationsReview=api;
})(typeof globalThis!=='undefined'?globalThis:this);
