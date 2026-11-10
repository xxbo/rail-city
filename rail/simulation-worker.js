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
    importScripts('value-wire.js?v=67', 'bootstrap-wasm.js?v=73','routing-wasm.js?v=73','forecast-catalog.js?v=73');Core=self.RailRouting;Bootstrap=self.RailBootstrap;Catalog=self.RailForecastCatalog;
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
        if(request.action==='create'){const forecast=Catalog.hydrate(args.forecast);result=Bootstrap.runtime('create',{world:args.world,saved:args.saved,start:args.start,warm:args.warm,catalog:Catalog.source(forecast).id,forecastView:{population:forecast.population,covered:forecast.catchment?.covered||0}});}
        else if(['demand','prepareImport'].includes(request.action)){const {forecast:transport,...command}=args;const forecast=Catalog.hydrate(transport),catalog=Catalog.source(forecast).id;try{result=Bootstrap.runtime(request.action,{...command,catalog,forecastView:{population:forecast.population,covered:forecast.catchment?.covered||0}});}finally{Bootstrap.forecast('release',{id:catalog});}}
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
