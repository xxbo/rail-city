/* Read-only diagnostics. Forecast cloned once per revision; never changes the simulation. */
importScripts('game-balance.js?v=17', 'fleet.js?v=65', 'regions.js?v=16', 'routing-wasm.js?v=65', 'value-wire.js?v=65', 'editor-wasm.js?v=65', 'assets-wasm.js?v=65', 'save-wasm.js?v=65', 'diagnostics-wasm.js?v=65', 'temporal-wasm.js?v=48', 'service-plan.js?v=65',
   'transactions-wasm.js?v=65', 'forecast-catalog.js?v=58', 'history-wasm.js?v=57', 'flow-history.js?v=57', 'statistics-wasm.js?v=57', 'operations-wasm.js?v=50', 'ridership.js?v=57', 'engine.js?v=65', 'network-stats.js?v=65', 'network.js?v=65',
  'metrics.js?v=65',
  'operations-center.js?v=65');
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
