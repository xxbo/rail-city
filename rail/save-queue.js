/* Promise transport for the Rust save scheduler. Native tickets select active,
   pending and coalesced captures; JS only invokes the selected IO callback. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const native=(action,args)=> (node?require('./bootstrap-wasm'):root.RailBootstrap).persistence(action,args);
function create(options={}){
  let id;const tasks=new Map(),queue=()=>id??(id=native('queueCreate',options));
  function start(ticket){const task=tasks.get(ticket);Promise.resolve().then(task.factory).then(value=>finish(ticket,true,value),error=>finish(ticket,false,error));}
  function finish(ticket,success,value){const task=tasks.get(ticket);tasks.delete(ticket);const next=native('queueFinish',{id:queue(),ticket,success,checkpoint:success?value:undefined}).next;if(success)task.resolve(value);else task.reject(value);if(next)start(next);}
  function request(factory){const result=native('queueRequest',{id:queue()});let task=tasks.get(result.ticket);if(task){task.factory=factory;return task.promise;}task={factory};task.promise=new Promise((resolve,reject)=>{task.resolve=resolve;task.reject=reject;});tasks.set(result.ticket,task);if(result.start)start(result.ticket);return task.promise;}
  return {request,async flush(){while(tasks.size)await Promise.allSettled([...tasks.values()].map(task=>task.promise));},stats:()=>native('queueStats',{id:queue()}),observe:at=>native('queueObserve',{id:queue(),at}),last:()=>native('queueLast',{id:queue()})};
}
const api={create};if(node)module.exports=api;else root.RailSaveQueue=api;
})(typeof globalThis!=='undefined'?globalThis:this);
