/* One native runtime per simulation worker; no cloned game world or second JS simulation. */
(function(){
  'use strict';
  const node=typeof module!=='undefined'&&module.exports;
  let Core,send,listen,Bootstrap,Catalog;
  if(node){
    Core=require('./routing-wasm');Bootstrap=require('./bootstrap-wasm');Catalog=require('./forecast-catalog');
    const {parentPort}=require('node:worker_threads');
    send=(data,transfer)=>parentPort.postMessage(data,transfer);
    listen=fn=>parentPort.on('message',fn);
  }else{
    importScripts('value-wire.js?v=67', 'bootstrap-wasm.js?v=74','routing-wasm.js?v=76','forecast-catalog.js?v=74');Core=self.RailRouting;Bootstrap=self.RailBootstrap;Catalog=self.RailForecastCatalog;
    send=(data,transfer)=>self.postMessage(data,transfer);
    listen=fn=>{self.onmessage=e=>fn(e.data);};
  }
  const tokens=()=>({simulation:Core.simulationToken(),queue:Core.queueToken(),engine:Core.engineToken(),
    sampling:Core.samplingToken(),cycle:Core.cycleToken()});
  listen(async request=>{
    try{
      await Core.init();
      if(request.kind==='session'){
        const args=request.args||{};let result;
        if(['create','demand','prepareImport'].includes(request.action)){
          const {forecast,...command}=args;
          const handle=await Catalog.receiveCatalog(forecast);
          try {
            const forecastView={population:forecast.population,covered:forecast.catchment?.covered||0};
            if(request.action==='create')command.transfer=true;
            result=Bootstrap.runtime(request.action,{...command,catalog:handle.id,forecastView});
          } finally {
            Bootstrap.forecast('release',{id:handle.id});
          }
        }
        else result=Bootstrap.runtime(request.action,args);
        send({id:request.id,result});return;
      }
      if(!['engine_cycle','engine_continue','engine_loop','engine_step','simulation_step','runtime_query'].includes(request.name))
        throw Error('Unknown simulation worker operation');
      Core.pinRuntime(!!request.retainRuntime);
      const result=Core.kernel(request.name,request.input,null,null,request.bytes);
      send({id:request.id,result,tokens:tokens(),status:Core.status()},[result.buffer]);
    }catch(error){send({id:request.id,error:error.message,tokens:tokens()});}
  });
})();
