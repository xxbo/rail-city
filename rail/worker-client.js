/* Platform handles and Promise correlation for Rust-owned Worker leases. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
// Rust selects the next ticket and delay. These handles belong to this client
// only, including while a replacement game is being prepared.
function refreshTimers(event,options,schedule,cancel,interrupt) {
 let timer=null,active=null;
 function clear(){if(timer!==null)cancel(timer);timer=null;}
 function arm(effect) {
  if(!effect)return;
  if(effect.clear)clear();
  if(effect.ticket===undefined)return;
  clear();
  const ticket=effect.ticket;
  timer=schedule(()=>{
   const start=event('wake',{ticket});
   if(!start?.run)return;
   timer=null;
   const finish=result=>{
    const effect=event('finish',{ticket,...result});
    active=null;
    arm(effect?.next);
    if(effect?.status)options.refreshNotice?.(effect.status,result.error);
   };
   active=Promise.resolve().then(()=>options.runRefresh(start.manual)).then(finish,
    error=>finish({error:error.message,repeatManual:start.manual}));
  },effect.delay);
 }
 return {
  signal:(manual=false)=>arm(event('signal',{manual})),
  pause(){arm(event('pause'));if(active)interrupt();return active||Promise.resolve();},
  resume:()=>arm(event('resume')),
  get pending(){return timer!==null||active!==null;},
  clear
 };
}

function create(options){
 const B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap;
 const id=B().platform('create',{timeout:options.timeout||30000,stateful:!!options.stateful});
 const call=(action,args={})=>{try{return B().platform(action,{id,...args});}catch(error){if(error.message==='RPC_DISPOSED')throw Object.assign(Error('后台客户端已关闭。'),{code:'RPC_DISPOSED'});throw error;}};
 const schedule=options.setTimer||setTimeout,cancel=options.clearTimer||clearTimeout;
 const jobs=new Map();let worker=null,epoch;
 function remove(ticket){const job=jobs.get(ticket);if(job){cancel(job.timer);jobs.delete(ticket);}return job;}
 function stop(action,error,sourceEpoch=epoch,ticket){
  const effect=call(action,{epoch:sourceEpoch,ticket});if(!effect.accepted)return;
  if(effect.terminate&&worker){worker.onmessage=worker.onerror=worker.onmessageerror=null;worker.terminate();worker=null;}
  const reason=effect.unknownCommit?Error('后台会话响应中断，提交结果待确认；请从已保存进度恢复。'):error;
  for(const ticket of effect.reject)remove(ticket)?.reject(reason);
  options.onFault?.(reason);
 }
 function start(){
  const next=call('open');if(worker)return worker;
  epoch=next;
  try{worker=options.createWorker();if(!worker)throw Error(options.errorMessage||'后台线程尚未开放。');}
  catch(error){stop('fault',error,next);throw error;}
  const current=worker,sourceEpoch=epoch;
  const receive=message=>{if(!call('settle',{epoch:sourceEpoch,ticket:message?.id})){options.discard?.(message);return;}const job=remove(message.id);if(!job)return;if(message.error)job.reject(Error(message.error));else job.resolve(message);};
  if(typeof current.on==='function'){
   current.on('message',receive);current.on('error',error=>stop('fault',error,sourceEpoch));
   current.on('exit',code=>stop('fault',Error('后台线程退出：'+code),sourceEpoch));
  }else{
   current.onmessage=event=>receive(event.data);
   current.onerror=event=>stop('fault',Error(event.message||options.errorMessage),sourceEpoch);
   current.onmessageerror=()=>stop('fault',Error(options.errorMessage||'后台消息损坏。'),sourceEpoch);
  }
  return current;
 }
 function request(payload,transfer=[]){let current,job;try{current=start();job=call('request');}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{const timer=schedule(()=>stop('timeout',Error(options.timeoutMessage||'后台任务超时。'),job.epoch,job.ticket),job.timeout);jobs.set(job.ticket,{resolve,reject,timer});try{current.postMessage({...payload,id:job.ticket},transfer);}catch(error){if(call('settle',{epoch:job.epoch,ticket:job.ticket}))remove(job.ticket)?.reject(error);}});
 }
 const now=options.now||(()=>performance.now());
 const refresh=options.runRefresh?refreshTimers((event,args)=>call('refresh',{event,at:now(),...args}),options,schedule,cancel,
  ()=>{if(!options.stateful && jobs.size)stop('fault',Error('FORECAST_PAUSED'));}):null;
 return {request,start,refresh,offer:()=>call('offer'),get active(){return call('status').active;},get pending(){return call('status').pending;},dispose(){refresh?.clear();stop('dispose',Error('后台客户端已关闭。'));}};
}
const api={create};if(node)module.exports=api;else root.RailWorkerClient=api;
})(typeof globalThis!=='undefined'?globalThis:this);
