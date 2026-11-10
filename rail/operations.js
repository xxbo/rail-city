/* Deterministic operating-day simulation, independent from quarterly forecasts. */
(function(root) {
  'use strict';
  const R = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.RailSim;
  const X = typeof module !== 'undefined' && module.exports ? require('./service-plan') : root
    .RailServicePlan;
  const DWELL = .6,
    CAPACITY = 800,
    SPACING = 2;

  const native=(action,s={},args={})=>R.compat(action,s,args).result;
  const routeTime=(s,line)=>native('routeTime',s,{line}),isOpen=(line,minute)=>native('operationsOpen',{}, {line,minute}),demandGroups=(s,metrics)=>native('operationsGroups',s,{metrics});
  const arenas=new WeakMap(),owned=(action,args)=>(typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap).legacyOperations(action,args);
  const releases=typeof FinalizationRegistry==='function'?new FinalizationRegistry(id=>{try{owned('close',{id});}catch{}}):null;
  function create(s,metrics,start=420){const out=owned('create',{state:s,metrics,start});arenas.set(out.runtime,out.id);releases?.register(out.runtime,out.id,out.runtime);return out.runtime;}
  function advance(rt,s,minutes){let id=arenas.get(rt);if(!id){id=owned('restore',{state:s,runtime:rt}).id;arenas.set(rt,id);releases?.register(rt,id,rt);}R.sync(rt,owned('advance',{id,state:s,minutes}).runtime);return rt;}

  function ease(p) {
    const a = .16,
      v = 1 / (1 - a);
    if (p < a) return v * p * p / (2 * a);
    if (p > 1 - a) return 1 - v * (1 - p) * (1 - p) / (2 * a);
    return v * (p - a / 2);
  }
  const geometryIndexes = new WeakMap();

  function geometryIndex(s) {
    let c = geometryIndexes.get(s.tracks);
    if (!c || c.nodes !== s.nodes || c.count !== s.tracks.length) {
      const parallel = new Map();
      for (const t of s.tracks) {
        const k = R.key(t.a, t.b);
        if (!parallel.has(k)) parallel.set(k, []);
        parallel.get(k).push(t);
      }
      for (const group of parallel.values()) group.sort((a, b) => a.id.localeCompare(b.id, undefined, {
        numeric: true
      }));
      c = {
        count: s.tracks.length,
        nodes: s.nodes,
        tracks: new Map(s.tracks.map(t => [t.id, t])),
        parallel,
        points: new Map()
      };
      geometryIndexes.set(s.tracks, c);
    }
    return c;
  }

  function cachedTrackPoints(s, index, tr, from) {
    const key = tr.id + '|' + from;
    let c = index.points.get(key);
    if (!c || c.curve !== tr.curve || c.bends !== tr.bends || c.km !== tr.km) {
      c = {
        curve: tr.curve,
        bends: tr.bends,
        km: tr.km,
        points: X.trackPoints(s, tr, from)
      };
      index.points.set(key, c);
    }
    return c.points;
  }

  function position(s, t, offsetScale = 1) {
    if (t.status !== 'moving') {
      const n = s.nodes[t.stops[t.index]];
      return {
        x: n.x,
        y: n.y,
        angle: t.dir === 1 ? 0 : 180,
        speed: 0,
        track: null
      };
    }
    const index = geometryIndex(s),
      p = ease(t.progress),
      tr = index.tracks.get(t.segment.track);
    const parallels = index.parallel.get(R.key(tr.a, tr.b)),
      pair = parallels.findIndex(x => x.id === tr.id),
      base = (pair - (parallels.length - 1) / 2) * 9,
      canonical = t.segment.from === tr.a ? 1 : -1,
      offset = (base * canonical * (tr.a < tr.b ? 1 : -1) + 2.2) * offsetScale;
    const ramp = t.progress < .16 ? t.progress / .16 : t.progress > .84 ? (1 - t.progress) / .16 : 1;
    const pos = X.along(cachedTrackPoints(s, index, tr, t.segment.from), p),
      angle = pos.angle * Math.PI / 180;
    return {
      x: pos.x - Math.sin(angle) * offset,
      y: pos.y + Math.cos(angle) * offset,
      angle: pos.angle,
      speed: 48 / (1 - .16) * Math.max(0, ramp),
      track: tr.id
    };
  }

  const summary=runtime=>arenas.has(runtime)?owned('summary',{id:arenas.get(runtime)}):native('operationsSummary',{}, {runtime});
  const api = {
    create,
    snapshot:rt=>arenas.has(rt)?owned('snapshot',{id:arenas.get(rt)}).runtime:rt,
    dispose:rt=>{if(arenas.has(rt))owned('close',{id:arenas.get(rt)});releases?.unregister(rt);arenas.delete(rt);},
    advance,
    position,
    summary,
    demandGroups,
    routeTime,
    isOpen,
    CAPACITY,
    DWELL,
    SPACING
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailOperations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
