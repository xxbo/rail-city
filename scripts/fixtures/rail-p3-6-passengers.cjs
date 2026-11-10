/* Weighted passenger cohorts retain their destination and transfer itinerary until arrival. */
(function(root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports,
    R = node ? require('./rail-p3-6-engine.cjs') : root.RailSim,
    B = node ? require('./rail-p3-6-operations.cjs') : root.RailOperations,
    C = node ? require('./rail-p3-6-city.cjs') : root.RailCity;
  const X = node ? require('../../rail/service-plan') : root.RailServicePlan;
  const Q = node ? require('../../rail/ridership') : root.RailRidership;
  const F = node ? require('../../rail/fleet') : root.RailFleet;
  const SIM = node ? require('./rail-p3-6-simulation-wasm.cjs') : root.RailSimulation;
  const Prepare = node ? require('./rail-p3-6-preparation-wasm.cjs') : root.RailPreparation;
  const Native = node ? require('../../rail/operations-wasm') : root.RailNativeOperations;
  const QUEUES = node ? require('./rail-p3-6-queue-runtime.cjs') : root.RailQueueRuntime;
  const key = (id, dir, station) => `${id}|${dir}|${station}`;

  const Runtime=node?require('../../rail/runtime-wasm'):root.RailRuntime;
  const TX=node?require('../../rail/transactions-wasm'):root.RailTransactions;
  const Routing=node?require('../../rail/routing-wasm'):root.RailRouting;
  const migrationFields=['minute','nextRouteRevision','routeArchives','retiredTracks','trains','defs','queues','waitSince','outside','outsideSince','transfers','stationLimits','departures','cancelled','rejected','stationOccupancy','fleetMinute'];
  const migrationState=rt=>Object.fromEntries(migrationFields.filter(k=>Object.hasOwn(rt,k)).map(k=>[k,rt[k]]));
  function adoptMigration(rt,result){if(result.definitionOrder){result.defs=result.definitionOrder.map((id,index)=>({...rt.defs[id],id:index,daily:0}));delete result.definitionOrder;delete result.definitionCount;}const trains=new Map(rt.trains.map(t=>[t.id,t]));result.trains=result.trains.map(t=>{const old=trains.get(t.id);return old?Object.assign(old,t):t;});Object.assign(rt,result);}
  function definitions(s,m) {const compact=(node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog).definitions(m);if(compact)return compact;const plan=X.expand(s),native=node?require('../../rail/save-wasm'):root.RailSave,out=[];for(let offset=0;offset<m.flows.length;offset+=512){const rows=native.run('definitions',{plan,flows:m.flows.slice(offset,offset+512),offset});for(const row of rows)out.push(row);}return out;}
  const MAX_SAVED_DEFINITIONS = 300000;
  const journeyKey=j=>(node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog).key(j);

  function validateCatalog(fresh) {
    const Compact=node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog;
    if (!Array.isArray(fresh) || (Compact.meta(fresh)?!Compact.totals(fresh).valid:!(node?require('../../rail/save-wasm'):root.RailSave).run('catalogValid',{value:fresh}))) throw Error('客流预测包含无效出行，已保留上次需求。');
    return fresh;
  }

  function installCatalog(rt, fresh) {
    Object.defineProperty(rt, 'demandCatalog', {
      value: fresh,
      writable: true,
      configurable: true,
      enumerable: false
    });
    const Compact=node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog,totals=Compact.meta(fresh)?Compact.totals(fresh):null;
    rt.demandStatus = {
      profiles: fresh.length,
      daily: totals?.daily ?? fresh.reduce((v, j) => v + j.daily, 0),
      activeProfiles: totals?.activeProfiles ?? fresh.reduce((n, j) => n + (j.daily > 0 ? 1 : 0), 0),
      updatedAt: rt.minute,
      storage: 'lazy'
    };
  }

  function materialize(rt, j) {
    if (!rt.demandCatalog) return j;
    return (node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog).materialize(rt,j);
  }

  function demandSummary(rt) {
    const catalog = rt.demandCatalog || rt.defs,
      stats = rt.demandCatalog ? rt.demandStatus : null;
    return {
      profiles: stats?.profiles ?? catalog.length,
      activeProfiles: stats?.activeProfiles ?? catalog.reduce((n, j) => n + (j.daily > 0 ? 1 : 0),
        0),
      daily: stats?.daily ?? catalog.reduce((n, j) => n + j.daily, 0),
      storedProfiles: rt.defs.length,
      lazy: !!rt.demandCatalog
    };
  }

  function create(s, m, start = 420, warm = true) {
    if(Runtime.supports(s,m))return Runtime.create(s,m,start,warm);
    Q.init(s, start);
    const plan = X.expand(s);
    const rt = {
      plan,
      city: true,
      minute: start - (warm ? 30 : 0),
      nextId: 1,
      arrivalMode: s.routeModel === 9 ? 'integer' : 'weighted',
      arrivalRemainder: 0,
      expectedGenerated: 0,
      rngState: 2463534242,
      stationOccupancy: {},
      stationLimits: Object.fromEntries([...new Set(plan.services.flatMap(l => l.callStops || l
          .stops))]
        .map(id => [id, Q.limits(s, id)])),
      outside: {},
      outsideSince: {},
      rejected: 0,
      trains: [],
      transfers: [],
      departures: {},
      blocks: {},
      queues: {},
      waitSince: {},
      defs: [],
      generated: 0,
      boarded: 0,
      alighted: 0,
      completed: 0,
      cancelled: 0,
      revenue: 0,
      vehicleExpense: 0,
      lineRevenue: {},
      lineBoarded: {},
      purposeCompleted: {
        work: 0,
        shopping: 0,
        leisure: 0
      }
    };
    const catalog = validateCatalog(m.preparedDefinitions || definitions(s, m));
    rt.defs = catalog.length <= 55000 ? catalog.map(j => ({
      ...j
    })) : [];
    installCatalog(rt, catalog);
    for (const [i, l] of plan.services.entries())
      for (const dir of X.directions(l)) rt.departures[l.id + '|' + dir] = {
        next: rt.minute + (i % 5) * .45 + (dir === -1 ? R.effectiveHeadway(s, l) / 2 : 0),
        headway: R.effectiveHeadway(s, l)
      };
    if (warm) advance(rt, s, 30);
    return rt;
  }

  function reject(rt, journey, count, events) {
    if (count <= 0) return;
    rt.cancelled += count;
    rt.rejected = (rt.rejected || 0) + count;
    events.push({
      journey,
      count
    });
  }

  function generate(rt, s, interval, carry, index) {
    if (rt.demandCatalog && rt.defs.length > 45000 && rt.minute - (rt.lastDefCompact ?? -
        Infinity) >= 5) {
      compactDefinitions(rt);
      rt.lastDefCompact = rt.minute;
    }
    rt.demandCarry = carry;
    const dt=interval;
    let feedback=null;
    if(interval) Q.step(s,rt,dt,(...args)=>{feedback=Native.feedbackFrame(...args);},true);
    const minute=Math.round(rt.minute*1e6)/1e6;
    const dispatch=SIM.dispatchFrame(rt,s,index);
    return {feedback,dispatch,interval,minute,sampling:!!interval};
  }

  function refreshFleet(rt) {
    (node ? require('../../rail/temporal-wasm') : root.RailTemporal).refreshFleet(rt);
  }
  const planIndexes = new WeakMap();

  function planIndex(s) {
    let c = planIndexes.get(s);
    if (!c || c.services !== s.services || c.tracks !== s.tracks || c.bases !== s.baseLines || c
      .trackCount !== s.tracks.length || c.runCount !== s.services.length) {
      c = {
        trackCount: s.tracks.length,
        runCount: s.services.length,
        services: s.services,
        tracks: s.tracks,
        bases: s.baseLines,
        runs: new Map(s.services.map(l => [l.id, l])),
        track: new Map(s.tracks.map(t => [t.id, t])),
        base: new Map((s.baseLines || []).map(l => [l.id, l])),
        archives: new Map()
      };
      planIndexes.set(s, c);
    }
    return c;
  }

  function trainTrack(rt, index, t, id) {
    if (!t.retiringKey) return index.track.get(id);
    let tracks = index.archives.get(t.retiringKey);
    const archive = rt.routeArchives?.[t.retiringKey];
    if (!tracks || tracks.source !== archive?.tracks) {
      tracks = {
        source: archive?.tracks,
        map: new Map((archive?.tracks || []).map(tr => [tr.id, tr]))
      };
      index.archives.set(t.retiringKey, tracks);
    }
    return tracks.map.get(id) || index.track.get(id);
  }

  function prepareTick(rt, s, dt, target, carry, interval, settlement=null) {
    s = rt.plan || s;
    rt.minute = target;
    if (Math.floor(rt.minute) !== rt.fleetMinute) {
      refreshFleet(rt);
      rt.fleetMinute = Math.floor(rt.minute);
    }
    const index = planIndex(s);
    const frames=generate(rt,s,interval,carry,index);
    return [rt,s,index,trainTrack,frames,reroute,settlement,journeyKey];
  }

  const legacyWindowsCache=new WeakMap();
  function legacyWindows(rt,s,minute){const services=s.services.map(l=>({id:l.id,open:l.open,close:l.close,fleetManaged:l.fleetManaged,fleet:l.fleet})),key=JSON.stringify(services),cached=legacyWindowsCache.get(rt);if(cached&&cached.key===key&&minute>=cached.start&&minute<cached.until)return cached.ids;const result=(node?require('../../rail/save-wasm'):root.RailSave).run('legacyWindows',{services,minute}),value={...result,key,ids:new Set(result.ids)};legacyWindowsCache.set(rt,value);return value.ids;}
  // Version-1 weighted saves retain their established streaming adapter. The default
  // version-9 game uses canonical native identities; avoid a second large key index for
  // historical all-positive weighted catalogs until their save migration is performed.
  function legacyTick(rt,s,index,track,frames,reroute,settlement) {
    const interval=frames.interval,dt=interval;
    const incoming=(()=>{
    const incoming = [];
    const catalog = rt.demandCatalog || rt.defs,
      minute = Math.round(rt.minute * 1e6) / 1e6;
    const open = interval?legacyWindows(rt,s,minute):null;
    function arrive(j, n) {
      if (n > 0) incoming.push({
        j,
        id: open.has(j.legs[0]?.service) ? materialize(rt, j).id : -1,
        n
      });
    }
    const integer = rt.arrivalMode === 'integer';
    // Finish metadata calls before encoding the sampling cache token: a native recycle
    // during dispatch metadata must never invalidate an already encoded delta frame.
    const dispatch=frames.dispatch;
    const sampling=interval?SIM.timedFrame(catalog,s,minute,dt,rt.arrivalRemainder||0,
      rt.rngState,integer):null;
    const result=Prepare.run(frames.feedback,sampling,dispatch);
    const sampled=result.sampled;
    if(!sampled) return {arrivals:[],gates:false,dispatch:result.dispatch};
    if (integer) {
      rt.expectedGenerated = (rt.expectedGenerated || 0) + sampled.total;
      rt.arrivalRemainder = sampled.remainder;
      rt.rngState = sampled.rng;
    }
    for (let i = 0; i < sampled.events.length; i += 2) arrive(catalog[sampled.events[i]], sampled
      .events[i + 1]);
    return {
      arrivals: incoming,
      gates: integer,
      dispatch:result.dispatch
    };
    })();
    if(incoming.dispatch.length){const result=(node?require('../../rail/save-wasm'):root.RailSave).run('legacyDispatch',{state:s,minute:rt.minute,nextId:rt.nextId,records:incoming.dispatch.map(({l,dir,action,next})=>({l,dir,action,next}))});for(const train of result.trains)rt.trains.push(train);rt.nextId=result.nextId;for(const[index,next,ran]of result.updates){const d=incoming.dispatch[index].d;if(ran)d.lastRun=rt.minute;d.next=next;}}
    QUEUES.step(rt, s, index, trainTrack, incoming.arrivals, incoming.gates, reroute, settlement);
  }
  function tick(...args) {
    const prepared=prepareTick(...args);
    if(prepared[1].routeModel!==9)legacyTick(...prepared);else QUEUES.cycle(...prepared);
  }
  async function tickAsync(...args) {
    if(args[0].defs.length>45000&&args[3]-(args[0].lastDefCompact??-Infinity)>=5)
      await QUEUES.materializeAsync(args[0]);
    const prepared=prepareTick(...args);
    if(prepared[1].routeModel!==9)legacyTick(...prepared);else await QUEUES.cycleAsync(...prepared);
  }

  function advance(rt, s, minutes) {
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw Error(
      'Invalid simulation interval');
    const agenda = Native.clock(rt.minute, minutes, rt.demandCarry || 0);
    for (let at = 1; at < agenda.length; at += 4) tick(rt, s, agenda[at], agenda[at + 1], agenda[
      at + 2], agenda[at + 3]);
    return rt;
  }

  function summary(rt) {
    if(rt.nativeView)return {active:rt.trains.length,...rt.nativeView.summary,inside:rt.nativeView.summary.waiting-rt.nativeView.summary.outside,
      completed:rt.completed,cancelled:rt.cancelled,generated:rt.generated,revenue:rt.revenue};
    const transferring = (rt.transfers || []).reduce((v, x) => v + x.amount, 0),
      outside = Object.values(rt.outside || {}).reduce((v, q) => v + Object.values(q).reduce((a,
          b) => a +
        b, 0), 0),
      waiting = outside + transferring + Object.values(rt.queues).reduce((v, q) => v + Object
        .values(q)
        .reduce((a, b) => a + b, 0), 0),
      onboard = rt.trains.reduce((v, t) => v + t.onboard, 0);
    return {
      active: rt.trains.length,
      waiting,
      inside: waiting - outside,
      outside,
      transferring,
      onboard,
      completed: rt.completed,
      cancelled: rt.cancelled,
      generated: rt.generated,
      revenue: rt.revenue
    };
  }

  function station(rt, id) {
    let waiting = 0;
    const lines = {},
      destinations = {},
      purposes = {
        work: 0,
        shopping: 0,
        leisure: 0
      };
    for (const [k, q] of Object.entries(rt.queues)) {
      const [line, dir, node] = k.split('|');
      if (+node !== id) continue;
      for (const [token, count] of Object.entries(q)) {
        waiting += count;
        const j = rt.defs[+token.split(':')[0]];
        if (j) {
          destinations[j.to] = (destinations[j.to] || 0) + count;
          purposes[j.purpose] += count;
        }
        lines[line] = (lines[line] || 0) + count;
      }
    }
    let transferring = 0;
    for (const x of rt.transfers || [])
      if (x.station === id) {
        transferring += x.amount;
        waiting += x.amount;
        const j = rt.defs[x.journey];
        if (j) {
          destinations[j.to] = (destinations[j.to] || 0) + x.amount;
          purposes[j.purpose] += x.amount;
          const line = j.legs[x.leg].service;
          lines[line] = (lines[line] || 0) + x.amount;
        }
      } const outside = Object.values(rt.outside?.[id] || {}).reduce((v, n) => v + n, 0),
      limit = Q.limits(rt.plan, id);
    return {
      today: Q.station(rt.plan, id, rt.minute),
      waiting,
      outside,
      capacity: limit.capacity,
      outsideCapacity: limit.outsideCapacity,
      transferring,
      lines,
      destinations,
      purposes
    };
  }

  function snapshot(rt) {
    if(Runtime.has(rt))return Runtime.snapshot(rt);
    if(!QUEUES.canSnapshot(rt))throw Error('原生运行中的存档请使用 snapshotAsync');
    const out = {
      ...rt
    };
    if (rt.plan.urban) out.urbanDefs = rt.defs;
    delete out.defs;
    delete out.plan;
    return out;
  }

  function restore(s, m, saved) {
    try {
      const plan={...X.expand(s)},catalog=m.preparedDefinitions||definitions(s,m),defs=s.urban&&saved?.urbanDefs?saved.urbanDefs:catalog;
      plan.tracks=[...s.tracks,...(saved?.retiredTracks||[]).filter(t=>!s.tracks.some(x=>x.id===t.id))];
      plan.routeArchives=saved?.routeArchives||{};
      if(!(node?require('../../rail/save-wasm'):root.RailSave).run('restore',{state:s,plan,saved,defs}))return null;
      if(Runtime.supports(s,m))return Runtime.create(s,m,saved.minute,false,saved);
      const rt={...saved,transfers:saved.transfers||[],plan,defs};
      installCatalog(rt,validateCatalog(catalog));return rt;
    }catch{return null;}
  }
  // A changed route drains its existing vehicles to their original terminus. New departures
  // use the new route immediately; existing passenger contracts retain their fare and destination.
  function routeKey(l, plan) {
    return JSON.stringify([l.stops, l.trackIds, l.callStops || l.stops, X.directions(l), l
      .trackIds.map(
        id => {
          const t = plan.tracks.find(t => t.id === id);
          return [t?.km, t?.curve, t?.bends];
        })
    ]);
  }

  function legValid(plan, e) {
    const l = plan.services.find(l => l.id === e.service);
    if (!l || !X.directions(l).includes(e.dir)) return false;
    const calls = l.callStops || l.stops;
    if (!calls.includes(e.from) || !calls.includes(e.to)) return false;
    return l.stops[0] === l.stops.at(-1) || (l.stops.indexOf(e.to) - l.stops.indexOf(e.from)) * e
      .dir > 0;
  }

  function reroute(rt, j, from) {
    if (from === j.to) return null;
    if (!(rt._routes instanceof Map)) Object.defineProperty(rt, '_routes', {
      value: new Map(),
      writable: true,
      configurable: true
    });
    const cacheKey = from + '|' + j.to + '|' + j.purpose + '|' + j.fare;
    let cached = rt._routes.get(cacheKey);
    if (cached !== undefined) return cached;
    const graph=Routing.graphFrame(rt.plan,R.network(rt.plan)),result=TX.run(22,{graph,journey:j,from,id:rt.defs.length}),next=result.journey;
    for(const [origin,purpose,data]of result.trees)rt._routes.set('paths|'+origin+'|'+purpose,Routing.pathsFromFrame(data,graph));
    if(next)rt.defs.push(next);rt._routes.set(cacheKey,next);return next;
  }

  function compactDefinitions(rt) {
    if(!QUEUES.canSnapshot(rt))throw Error('出行整理前需读取原生快照');QUEUES.invalidate(rt);
    if(Routing.status().memoryBytes>64*1024*1024)Routing.recycleSimulation();
    const input=[1,rt.defs.length],add=t=>input.push(+t.split(':')[0]);
    for(const q of Object.values(rt.queues))Object.keys(q).forEach(add);for(const q of Object.values(rt.outside))Object.keys(q).forEach(add);
    for(const t of rt.trains)Object.keys(t.passengers).forEach(add);for(const x of rt.transfers)input.push(x.journey);
    const order=Routing.kernel('compact_run',Float64Array.from(input)),mapping=new Map(Array.from(order,(old,id)=>[old,id])),defs=Array.from(order,(old,id)=>({...rt.defs[old],id,daily:0}));
    const token=t=>{const parts=t.split(':');parts[0]=mapping.get(+parts[0]);return parts.join(':');},remap=q=>Object.fromEntries(Object.entries(q).map(([t,n])=>[token(t),n]));
    for(const k of Object.keys(rt.queues))rt.queues[k]=remap(rt.queues[k]);for(const k of Object.keys(rt.outside))rt.outside[k]=remap(rt.outside[k]);
    for(const t of rt.trains)t.passengers=remap(t.passengers);for(const x of rt.transfers)x.journey=mapping.get(x.journey);
    for(const field of ['waitSince','outsideSince'])rt[field]=Object.fromEntries(Object.entries(rt[field]).filter(([k])=>mapping.has(+k.split('#')[1]?.split(':')[0])).map(([k,v])=>{const [key,t]=k.split('#');return [key+'#'+token(t),v];}));
    rt.defs=defs;rt._routes=null;
  }

  function reconcile(rt, s, m = null) {
    if(Runtime.has(rt))throw Error('原生运行会话请提交结构化编辑命令。');
    if(!QUEUES.canSnapshot(rt))throw Error('线网变更前需等待 materializeAsync');QUEUES.invalidate(rt);
    const prediction=m?validateCatalog(m.preparedDefinitions||definitions(s,m)):null,
      fresh=prediction===rt.defs?prediction.map(j=>({...j})):prediction,previous=rt.plan,plan=X.expand(s);
    if(fresh&&rt.defs.length+fresh.length>55000)compactDefinitions(rt);
    const limits=Object.fromEntries([...new Set(plan.services.flatMap(l=>l.callStops||l.stops))].map(id=>[id,Q.limits(s,id)])),
      directions=Object.fromEntries(plan.services.map(l=>[l.id,X.directions(l)])),headways={};
    for(const l of plan.services)for(const dir of X.directions(l))headways[l.id+'|'+dir]=R.effectiveHeadway(plan,l);
    let validCatalog=null;
    if(!fresh&&rt.demandCatalog){const catalog=rt.demandCatalog,ids=[];for(let at=0;at<catalog.length;at+=512){const journeys=[];for(let i=at;i<Math.min(at+512,catalog.length);i++)journeys.push((node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog).meta(catalog)?(node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog).legs(catalog,i):catalog[i].legs);const flags=TX.run(23,{plan:{services:plan.services},directions,journeys});for(let i=0;i<flags.length;i++)if(flags[i])ids.push(at+i);}validCatalog=(node?require('./rail-p3-6-forecast-catalog.cjs'):root.RailForecastCatalog).select(catalog,ids);}
    const graph=Routing.revisionGraph(plan);
    if(Routing.status().memoryBytes>64*1024*1024)Routing.recycleSimulation();
    const result=TX.run(21,{runtime:migrationState(rt),previous:{services:previous.services,tracks:previous.tracks},plan:{services:plan.services,tracks:s.tracks},
      oldSignatures:Object.fromEntries(previous.services.map(l=>[l.id,routeKey(l,previous)])),newSignatures:Object.fromEntries(plan.services.map(l=>[l.id,routeKey(l,plan)])),
      limits,directions,headways,catalog:!!fresh,graph});
    Object.defineProperty(rt,'_nativeRoutingGraph',{value:graph,writable:true,configurable:true});Object.defineProperty(rt,'_nativeRouteTrees',{value:result.trees,writable:true,configurable:true});
    adoptMigration(rt,result.runtime);rt.plan=plan;plan.routeArchives=rt.routeArchives;plan.tracks=[...s.tracks,...rt.retiredTracks];
    rt._routes=result.routeCache.length?new Map(result.routeCache.map(([from,to,purpose,fare,id])=>[from+'|'+to+'|'+purpose+'|'+fare,id===null?null:rt.defs[id]])):null;
    for(const [origin,purpose,data]of result.trees)rt._routes.set('paths|'+origin+'|'+purpose,Routing.pathsFromFrame(data,graph));
    if(fresh||validCatalog)installCatalog(rt,fresh||validCatalog);Q.rejectBatch(s,rt,result.rejected);return rt;
  }

  function rebase(rt, s, m) {
    if(Runtime.has(rt))return Runtime.replaceDemand(rt,m);
    return reconcile(rt,s,m);
  }
  const api = {
    advanceTick: (rt, s, dt, target, carry, interval, settlement=null) => {
      if (dt > 1e-9) tick(rt, s, dt, target, carry, interval, settlement);
      return rt;
    },
    continueRun:(rt,s,minutes,options)=>QUEUES.continueRun(rt,s,minutes,{...options,reroute}),
    continueAsync:(rt,s,minutes,options)=>QUEUES.continueAsync(rt,s,minutes,{...options,reroute}),
    advanceTickAsync:(rt,s,dt,target,carry,interval,settlement)=>dt>1e-9?tickAsync(rt,s,dt,target,carry,interval,settlement):Promise.resolve(rt),
    dispose:rt=>{if(Runtime.has(rt))Runtime.dispose(rt);else QUEUES.dispose(rt);},
    demandSummary,
    MAX_SAVED_DEFINITIONS,
    reconcile,
    rebase,
    create,
    advance,
    position: (s, t, scale) => B.position(t.retiringKey && s.routeArchives?.[t.retiringKey] ? {
      ...s,
      tracks: s.routeArchives[t.retiringKey].tracks
    } : s, t, scale),
    summary,
    station,
    snapshot,
    snapshotAsync:async rt=>{if(Runtime.has(rt))return Runtime.snapshotAsync(rt);await QUEUES.historyAsync(rt);return snapshot(await QUEUES.queryAsync(rt));},
    historyAsync:rt=>Runtime.has(rt)?Runtime.materializeAsync(rt):QUEUES.historyAsync(rt),
    detailsAsync:async(rt,kind,id)=>{
      if(Runtime.has(rt)){await Runtime.materializeAsync(rt);return kind==='station'?station(rt,id):rt.trains.find(t=>t.id===id)?.passengers||{};}
      if(kind==='station')return station(await QUEUES.queryAsync(rt,3,id),id);
      const temp=await QUEUES.queryAsync(rt,4,id);return temp.trains.find(t=>t.id===id)?.passengers||{};
    },
    materializeAsync:rt=>Runtime.has(rt)?Runtime.materializeAsync(rt):QUEUES.materializeAsync(rt),
    nativeViews:QUEUES.nativeViews,
    setDaily:(rt,index,value)=>{
      const catalog=rt.demandCatalog||rt.defs,previous=catalog[index]?.daily;
      SIM.setDaily(catalog,index,value);
      if(rt.demandStatus&&!Object.is(previous,value)){
        rt.demandStatus.daily+=value-previous;rt.demandStatus.activeProfiles+=(value>0?1:0)-(previous>0?1:0);
        rt.demandStatus.updatedAt=rt.minute;
      }
    },
    restore,
    definitions
  };
  if (node) module.exports = api;
  else root.RailPassengers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
