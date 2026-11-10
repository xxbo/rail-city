/* Demand never blocks map input. Worker caches the fixed city-wide OD distribution. */
importScripts('game-balance.js?v=66', 'fleet.js?v=66', 'regions.js?v=66', 'gba-data.js?v=66',
  'routing-wasm.js?v=70', 'value-wire.js?v=67', 'bootstrap-wasm.js?v=70', 'editor-wasm.js?v=66', 'assets-wasm.js?v=65', 'save-wasm.js?v=65', 'diagnostics-wasm.js?v=67', 'temporal-wasm.js?v=48', 'service-plan.js?v=67', 'engine.js?v=66', 'tokyo-data.js?v=66', 'hubs.js?v=66', 'connection-model.js?v=67',
  'demand-kernels.js?v=43', 'forecast-catalog.js?v=70', 'demand-world.js?v=67', 'demand-model.js?v=67', 'city-development.js?v=70', 'urban-growth.js?v=70',
  'city.js?v=66',
   'transactions-wasm.js?v=65', 'history-wasm.js?v=57', 'flow-history.js?v=57', 'statistics-wasm.js?v=57', 'operations-wasm.js?v=50', 'ridership.js?v=57', 'operations.js?v=30', 'demand-rates.js?v=31',
  'simulation-wasm.js?v=67', 'engine-wasm.js?v=49', 'preparation-wasm.js?v=50', 'queue-runtime.js?v=67', 'passengers.js?v=70');
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
