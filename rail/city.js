/* Real 2020 population / 2021 urban land-use extract; employment and commercial opportunities remain model estimates. */
(function(root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports,
    R = node ? require('./engine') : root.RailSim;
  const X = node ? require('./service-plan') : root.RailServicePlan;
  const D = node ? require('./demand-model') : root.RailDemand;
  const U = node ? require('./urban-growth') : root.RailUrban;
  const CELL = 2000 / 120,
    AREA = .7,
    WALK = .8,
    DETOUR = 1.25;
  let cached;

  function source() {
    return node ? require('./tokyo-data') : root.RailCityData;
  }

  function create(region='tokyo') {
    if(region==='gba')return (node?require('./gba-data'):root.RailGBA).create();
    if(cached)return cached;
    cached=(node?require('./bootstrap-wasm'):root.RailBootstrap).view('city',region);
    cached.metadata.raw=(node?require('./tokyo-data'):root.RailCityData).raw;
    let demand;Object.defineProperty(cached,'demand',{enumerable:true,get:()=>demand||(demand=buildDemand(cached.cells))});return (node?require('./bootstrap-wasm'):root.RailBootstrap).readonly(cached);
  }

  const legacy=(action,s={},args={})=>R.compat(action,s,args).result;
  function buildDemand(){return {profiles:legacy('cityProfiles'),trips:(origin,destination,profile)=>legacy('cityTrips',{}, {origin,destination,profile})};}
  function* journeys(mapping){let cursor=0;do{const page=legacy('cityJourneys',{}, {mapping:[...mapping],cursor,count:256});yield*page.rows;cursor=page.next;}while(cursor!==null);}
  function world(s) {
    return U.city(s, create(s.region));
  }

  function local(point, radius = .8, region = 'tokyo', state = null) {
    return D.local(state ? world(state) : create(region), point, radius);
  }

  function assign(s) {
    if (s.routeModel === 9) return D.assign(s, world(s));
    return assignLegacy(s);
  }

  function assignLegacy(s){const out=legacy('cityAssign',s);out.mapping=new Map(out.mapping);return out;}
  function evaluate(s,options={}) {
    if (s.routeModel === 9) return D.evaluate(s, world(s),options);
    return evaluateLegacy(s);
  }

  function evaluateLegacy(s){const out=legacy('cityEvaluate',s),descriptor=out.nativeCatalog;delete out.nativeCatalog;out.catchment.mapping=new Map(out.catchment.mapping);return (node?require('./forecast-catalog'):root.RailForecastCatalog).adopt(out,descriptor,true);}
  const profile = (...args) => (node ? require('./temporal-wasm') : root.RailTemporal).profile(...
    args);
  const api = {
    world,
    create,
    journeys,
    local,
    assign,
    evaluate,
    profile,
    CELL,
    AREA,
    WALK,
    DETOUR
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailCity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
