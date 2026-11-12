// This worker owns one trial session. The established WASM contracts handle every
// quote, purchase, dispatch, journey, fare and clock update.
let emptyWorld, city, locations, runtimeId;
let nodeKeys, stationNodes;
function smallTokyoDataset() {
  const source = RailBootstrap.view('city', 'tokyo');
  const cells = source.cells.filter(c => c.x >= 1240 && c.x < 1430 && c.y >= 810 && c.y <= 990);
  const totals = Object.fromEntries(Object.keys(source.totals).map(key =>
    [key, cells.reduce((sum, cell) => sum + (cell[key] || 0), 0)]));
  return {cells, totals, metadata: {effectiveConnections: true, demandZoneUnits: 40}};
}
function transact(state, kind, op, args) {
  const next = RailBootstrap.compat('assetChange', {command: {kind, op, args}}, state);
  if (next.result.error) throw Error(next.result.error);
  return next;
}
function prepare(route) {
  const points = route.map(key => locations[key]);
  const built = transact(emptyWorld, 'network', 'addLine', {points, options: {stockSpec: '6B'}});
  const stocked = transact(built.state, 'fleet', 'purchase', {spec: '6B', count: 4});
  return transact(stocked.state, 'network', 'configure', {id: built.result.id,
    values: {dispatch: {mode: 'manual', manual: 4, offPeak: 4, peak: 4}}}).state;
}
function cny(value) { return RailBootstrap.viewModel('currencyTo', {value}); }
function scene(result) {
  const rt = result.runtime;
  return {minute: rt.minute, cash: cny(result.worldPatch.economy.cash), boarded: rt.boarded,
    completed: rt.completed, waiting: rt.nativeView?.summary?.waiting ?? 0,
    stations: Object.fromEntries(stationNodes.map(([key, id]) => [key, rt.nativeView?.stations?.[id] ?? 0])),
    trains: rt.trains.map(t => ({id: t.id, load: t.onboard, capacity: t.capacity,
      from: nodeKeys[t.status === 'moving' ? t.segment.from : t.stops[t.index]],
      to: nodeKeys[t.status === 'moving' ? t.segment.to : t.stops[t.index]],
      moving: t.status === 'moving', progress: t.status === 'moving' ? t.progress : 0})),
    running: result.clock?.ok !== false};
}
onmessage = async ({data}) => {
  const {id, action} = data;
  try {
    await RailRoutingReady;
    let result;
    if (action === 'open') {
      locations = Object.fromEntries(data.places.map(p =>
        [p.key, RailBootstrap.run('tokyoProject', {lon: p.lon, lat: p.lat})]));
      emptyWorld = RailBootstrap.compat('managementInit', {}, RailBootstrap.run('empty', {region:'tokyo'})).state;
      city = smallTokyoDataset();
      result = {cash: cny(emptyWorld.economy.cash)};
    } else if (action === 'quote' || action === 'build') {
      const candidate = prepare(data.route);
      const cost = cny(emptyWorld.economy.cash - candidate.economy.cash);
      if (action === 'quote') result = {cost};
      else {
        const forecast = RailDemandWorld.evaluate(candidate, city, {compact: true});
        const catalog = RailForecastCatalog.source(forecast);
        const view = RailBootstrap.runtime('create', {world: candidate, catalog: catalog.id, start: 480, warm: false});
        runtimeId = view.id;
        stationNodes = candidate.services[0].stops.map((node, index) => [data.route[index], node]);
        nodeKeys = Object.fromEntries(stationNodes.map(([key, node]) => [node, key]));
        result = scene(view);
      }
    } else if (action === 'pulse') {
      result = scene(RailBootstrap.runtime('pulse', {id: runtimeId, at: data.at,
        playing: data.playing, visible: data.visible, speed: data.speed, budget: 8}));
    } else throw Error('未知操作');
    postMessage({id, result});
  } catch (error) {postMessage({id, error: error.message});}
};
