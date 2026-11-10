/* Destination-limited activity budgets. Parameters are explicit game assumptions. */
(function(root) {
  'use strict';
  const VERSION = 36,
    CAPACITY = {
      work: .95,
      shopping: 1.8,
      leisure: 1.5
    },
    FIELDS = {
      work: 'jobs',
      shopping: 'shops',
      leisure: 'leisure'
    },
    RATES = {
      work: .52,
      shopping: .16,
      leisure: .12
    };

  const kernels = () => typeof module !== 'undefined' && module.exports ? require('./demand-kernels') : root.RailDemandKernels;
  const budgets = city => kernels().budgets(city);
  const visitorBudget = (city,total) => kernels().visitorBudget(city,total);
  const capRows = (matrix,rows,n) => kernels().capRows(matrix,rows,n);
  const reserveExternal = (allocations,zones,reachable) => kernels().reserveExternal(allocations,zones,reachable);

  function summarize(s, model) {
    const node=typeof module!=='undefined'&&module.exports,Compact=node?require('./forecast-catalog'):root.RailForecastCatalog,
      TX=node?require('./transactions-wasm'):root.RailTransactions,dto=Compact.source(model),flows=[];
    if(dto)return Compact.connections(model,s);
    for(const f of model.flows)flows.push([f.from,f.to,f.purpose,f.back,f.demandTrips??f.trips,f.path.minutes+f.walk,f.hub,f.path.transfers,f.routeOptions,f.externalKind,f.path.edges.flatMap(e=>(e.parts||[]).map(p=>p.line))]);
    return TX.run(30,{services:s.services.map(l=>({id:l.id,stops:l.stops})),stations:model.catchment.stations,flows});
  }

  const api = {
    VERSION,
    CAPACITY,
    FIELDS,
    RATES,
    budgets,
    capRows,
    visitorBudget,
    reserveExternal,
    summarize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailConnections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
