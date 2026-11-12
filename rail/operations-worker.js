/* Read-only diagnostics. Forecast cloned once per revision; never changes the simulation. */
importScripts('game-balance.js?v=66', 'fleet.js?v=66', 'regions.js?v=66', 'routing-wasm.js?v=79', 'value-wire.js?v=67', 'bootstrap-wasm.js?v=78', 'editor-wasm.js?v=66', 'assets-wasm.js?v=79', 'save-wasm.js?v=65', 'diagnostics-wasm.js?v=67', 'temporal-wasm.js?v=79', 'service-plan.js?v=77',
   'transactions-wasm.js?v=65', 'forecast-catalog.js?v=74', 'history-wasm.js?v=57', 'flow-history.js?v=79', 'ridership.js?v=57', 'engine.js?v=73', 'network-stats.js?v=65', 'network.js?v=66',
  'metrics.js?v=65',
  'operations-center.js?v=73');
let forecast = null,
  version = null;
onmessage = async ({
  data: m
}) => {
  try {
    await self.RailRoutingReady;
    if (m.forecast) {
      forecast = RailForecastCatalog.hydrate(m.forecast);
      version = m.version;
    }
    if (!forecast || version !== m.version) throw Error('诊断预测版本不匹配');
    const start = performance.now(),
      bundle = RailOperationsCenter.bundle(m.state, forecast, m.runtime),
      rows = bundle.rows, metrics = bundle.metrics;
    postMessage({
      id: m.id,
      version,
      rows,
      metrics,
      ms: performance.now() - start
    });
  } catch (e) {
    postMessage({
      id: m.id,
      error: e.message
    });
  }
};
