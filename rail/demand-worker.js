/* Demand never blocks map input. Worker caches the fixed city-wide OD distribution. */
importScripts('game-balance.js?v=17', 'fleet.js?v=65', 'regions.js?v=16', 'gba-data.js?v=16',
  'routing-wasm.js?v=65', 'value-wire.js?v=65', 'editor-wasm.js?v=65', 'assets-wasm.js?v=65', 'save-wasm.js?v=65', 'diagnostics-wasm.js?v=65', 'temporal-wasm.js?v=48', 'service-plan.js?v=65', 'engine.js?v=65', 'tokyo-data.js?v=9', 'hubs.js?v=43', 'connection-model.js?v=58',
  'bounded-cache.js?v=40', 'demand-kernels.js?v=43', 'forecast-catalog.js?v=58', 'demand-world.js?v=58', 'demand-model.js?v=58', 'city-development.js?v=65', 'urban-growth.js?v=65',
  'city.js?v=58',
   'transactions-wasm.js?v=65', 'history-wasm.js?v=57', 'flow-history.js?v=57', 'statistics-wasm.js?v=57', 'operations-wasm.js?v=50', 'ridership.js?v=57', 'operations.js?v=30', 'demand-rates.js?v=31',
  'simulation-wasm.js?v=58', 'engine-wasm.js?v=49', 'preparation-wasm.js?v=50', 'queue-runtime.js?v=59', 'passengers.js?v=65');
onmessage = async ({
  data: m
}) => {
  try {
    await Promise.all([self.RailDataReady, self.RailRoutingReady]);
    const result = RailCity.evaluate(m.state,{compact:true});
    if(!result.preparedDefinitions)result.preparedDefinitions = RailPassengers.definitions(m.state, result);
    postMessage({
      id: m.id,
      result:RailForecastCatalog.transport(result)
    });
  } catch (e) {
    postMessage({
      id: m.id,
      error: e.message
    });
  }
};
