/* Demand never blocks map input. Worker caches the fixed city-wide OD distribution. */
importScripts('game-balance.js?v=66', 'fleet.js?v=66', 'regions.js?v=66', 'gba-data.js?v=66',
  'routing-wasm.js?v=74', 'value-wire.js?v=67', 'bootstrap-wasm.js?v=74', 'editor-wasm.js?v=66', 'assets-wasm.js?v=65', 'save-wasm.js?v=65', 'diagnostics-wasm.js?v=67', 'temporal-wasm.js?v=48', 'service-plan.js?v=67', 'engine.js?v=73', 'tokyo-data.js?v=66', 'hubs.js?v=66', 'connection-model.js?v=67',
  'demand-kernels.js?v=43', 'forecast-catalog.js?v=74', 'demand-world.js?v=67', 'demand-model.js?v=67', 'city-development.js?v=73', 'urban-growth.js?v=73',
  'city.js?v=73',
   'transactions-wasm.js?v=65', 'history-wasm.js?v=57', 'flow-history.js?v=57', 'statistics-wasm.js?v=57', 'operations-wasm.js?v=50', 'ridership.js?v=57', 'operations.js?v=73', 'demand-rates.js?v=31');
// A single pull covers at most eight native pages. A transferred buffer is
// detached here as soon as it is posted to the simulation worker.
function servePages(port,iterator,release) {
  let finished=false;
  function close() {
    if(finished)return;
    finished=true;
    port.removeEventListener('close',close);
    port.onmessage=port.onmessageerror=null;
    port.close();
    iterator.return?.();
    release();
  }
  port.addEventListener('close',close);
  port.onmessageerror=close;
  port.onmessage=({data})=>{
    try {
      if(data==='cancel')return close();
      if(data!=='pull')throw Error('INVALID_FORECAST_REQUEST');
      for(let i=0;i<8;i++) {
        const {done,value}=iterator.next();
        if(done){port.postMessage(null);close();return;}
        port.postMessage(value,[value.values.buffer]);
      }
      port.postMessage('more');
    } catch(error) {
      try{port.postMessage({error:error.message});}finally{close();}
    }
  };
  port.start();
  return close;
}

onmessage = async ({data: request}) => {
  let channel,forecast,close;
  function release() {
    const handle=forecast && RailForecastCatalog.source(forecast);
    if(handle)RailBootstrap.forecast('release',{id:handle.id});
    forecast=null;
  }
  try {
    await Promise.all([self.RailDataReady, self.RailRoutingReady]);
    forecast=RailCity.evaluate(request.state,{compact:true});
    if(!RailForecastCatalog.source(forecast))RailForecastCatalog.attachLegacy(forecast,request.state);
    const manifest=RailForecastCatalog.describe(forecast);
    if(request.handoff && typeof MessageChannel==='function')channel=new MessageChannel();
    const includeUI=!channel || request.handoff!=='runtimeOnly';
    const source=RailForecastCatalog.exportPages(forecast,manifest);
    const pages=includeUI?Array.from(source):null;
    const result=includeUI?{...forecast}:{population:forecast.population,catchment:{covered:forecast.catchment?.covered}};
    delete result.flows;
    delete result.preparedDefinitions;
    result.compactForecast={manifest,pages};
    if(channel) {
      // When the UI needs its own read copy, clone it once into the UI and
      // transfer the queued originals to the runtime as it requests them.
      close=servePages(channel.port1,pages?pages.values():source,release);
      postMessage({id:request.id,result,handoff:channel.port2},[channel.port2]);
      if(includeUI)release();
    } else {
      postMessage({id:request.id,result},RailForecastCatalog.transfers(result));
      release();
    }
  } catch(error) {
    close?.();
    channel?.port2.close();
    release();
    postMessage({id:request.id,error:error.message});
  }
};
