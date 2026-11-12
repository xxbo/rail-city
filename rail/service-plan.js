/* Infrastructure geometry, distance tariffs and stop-pattern services. No UI dependencies. */
(function(root) {
  'use strict';
  const KINDS = {
    local: '普通·大交路',
    short: '区间·小交路',
    express: '快速',
    direct: '直达',
    cross: '跨线'
  };
  const Editor = typeof module !== 'undefined' && module.exports ? require('./editor-wasm') : root
    .RailEditor;
  const TRANSFER = 4;
  const distance = (a, b) => Editor.numeric(2, [Number(a?.x), Number(a?.y), Number(b?.x), Number(b?.y)])[1];
  const sum = points => Editor.numeric(1, [points.length, ...Editor.coords(points)], points)[1];
  const smooth = (points, before = null, after = null, version = 12) => Editor.smooth(points, before, after,
    version);

  function rawTrackPoints(s, t, from = t.a) {
    const points = [s.nodes[t.a], ...(t.bends || []), s.nodes[t.b]];
    return from === t.a ? points : [...points].reverse();
  }

  function trackPoints(s, t, from = t.a) {
    let points = rawTrackPoints(s, t);
    if (t.curve) points = Editor.smooth(points, t.curve.before, t.curve.after, t.curve.version || 11, t);
    return from === t.a ? points : [...points].reverse();
  }
  const geometry = (s, line, shapes) => Editor.mutate(s, 'geometry', {
    line,
    shapes
  });

  function linePoints(s, l) {
    const out = [];
    for (let i = 0; i < l.trackIds.length; i++) {
      const points = trackPoints(s, s.tracks.find(t => t.id === l.trackIds[i]), l.stops[i]);
      out.push(...(i ? points.slice(1) : points));
    }
    return out;
  }

  function along(points, progress) {
    const v = Editor.numeric(3, [progress, points.length, ...Editor.coords(points)], points);
    return v[4] >= 0 ? {
      ...points[v[4]],
      angle: v[3]
    } : {
      x: v[1],
      y: v[2],
      angle: v[3]
    };
  }
  const draftLegs = (s, points) => Editor.query(s, 'draftLegs', {
    points
  });

  const planningView=()=>typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap;
  function lineSettings(l) {
    const {stops,fleet,headway,patterns,fareBands}=l;
    return planningView().viewModel('lineSettings',{line:{stops,fleet,headway,patterns,fareBands}});
  }
  function fare(l, km) {
    return planningView().viewModel('distanceFare',{line:{fareBands:l.fareBands},km});
  }
  function feedbackFares(l,length) {
    return planningView().viewModel('feedbackFares',{line:{fareBands:l.fareBands},length});
  }
  function patterns(l) {
    if(l.patterns)return l.patterns;
    // A caller may edit this draft before applying the configuration.
    return lineSettings(l).patterns.map(p=>({...p,calls:[...p.calls]}));
  }

  function patternDraft(s, lineId, operation, args={}) {
    const services=s.services.map(({id,stops,trackIds,fleet,fleetManaged,stockSpec,headway,dispatch})=>
      ({id,stops,trackIds,fleet,fleetManaged,stockSpec,headway,dispatch}));
    return planningView().viewModel('patternDraft',{state:{services},lineId,operation,...args});
  }

  function serviceOwner(action,s,minute,line,p,index,strict=false){
    const node=typeof module!=='undefined'&&module.exports,B=node?require('./bootstrap-wasm'):root.RailBootstrap;
    const pattern=p=>p&&({...p,...(Array.isArray(p.calls)?{calls:p.calls.filter(()=>true)}:{})});
    const packet=l=>l&&({...l,...(Array.isArray(l.patterns)?{patterns:l.patterns.map(pattern)}:{})});
    return B.forecast(action,{state:{services:s.services.map(packet)},minute,line:packet(line),
      sourceIndex:line?s.services.indexOf(line):0,pattern:pattern(p),index,strict});
  }
  function serviceFrame(s,minute){
    const frame=serviceOwner('serviceFrame',s,minute,null,null,undefined,true);
    frame.trackIndex=new Map(frame.trackNames.map((id,i)=>[id,i]));
    return frame;
  }
  function compileServices(s,minute,line=null,p=null,index){
    return serviceOwner('compiledServices',s,minute,line,p,index);
  }

  function compile(s, line, p, index, minute = s.economy?.minute ?? 420) {
    return compileServices(s, minute, line, p, index)[0];
  }

  function expand(s, minute = s.economy?.minute ?? 420) {
    if (s.routeModel !== 9 || s.operatingPlan) return s;
    return {
      ...s,
      operatingPlan: true,
      baseLines: s.services,
      services: compileServices(s, minute)
    };
  }

  const duration = (s, l) => Editor.metric(s, l, 1);
  const headway = (s, l) => Editor.metric(s, l, 2);
  const loopDwell = (s, l) => Editor.metric(s, l, 3);

  const directionViews=new WeakMap();
  function directions(l){const first=l.stops[0],last=l.stops.at(-1),dir=l.loopDirection;let c=directionViews.get(l);if(!c||c.first!==first||c.last!==last||c.dir!==dir){const mask=Editor.numeric(6,[+(first===last),['both','forward','reverse'].indexOf(dir)+1],l)[1];c={first,last,dir,value:mask===1?[1]:mask===2?[-1]:[1,-1]};directionViews.set(l,c);}return c.value.slice();}

  function directionName(s, l, dir) {
    const points = l.stops.map(id => s.nodes[id]);
    return Editor.numeric(5, [dir, points.length, ...Editor.coords(points)], l)[1] ? '外环' : '内环';
  }

  function validate(s) {
    try {
      const frame = serviceFrame(s, s.economy?.minute ?? 420);
      const num = v => typeof v === 'number' ? v : NaN;
      const values = [2, frame.input.length, ...frame.input, +(s.routeModel === 9 && !s.operatingPlan), +!!s
        .world, Number(s.world?.width), Number(s.world?.height), frame.trackNames.length, s.tracks.length
      ];
      for (const t of s.tracks) {
        values.push(frame.trackIndex.get(t.id) ?? -1, Number(t.km));
        for (const p of [t.curve?.before, t.curve?.after]) {
          values.push(+!!p);
          if (p) values.push(num(p.x), num(p.y));
        }
        const bends = t.bends,
          points = Array.isArray(bends) ? bends.filter(() => true) : [];
        values.push(!bends ? 0 : Array.isArray(bends) ? 1 : -1, Array.isArray(bends) ? bends.length : 0,
          points
          .length);
        for (const p of points) values.push(num(p.x), num(p.y));
      }
      for (const l of s.services) {
        const bands = l.fareBands,
          n = Array.isArray(bands) ? bands.length : 0;
        values.push(!bands ? 0 : Array.isArray(bands) ? 1 : -1, n);
        for (let i = 0; i < n; i++) values.push(+(i in bands), num(bands[i]));
        values.push(!l.loopDirection ? 0 : ['both', 'forward', 'reverse'].indexOf(l.loopDirection) + 1 || -
          1,
          Number(l.headway), Number(l.callStops ? l.callStops.length : l.stops.length), +!!l
          .dispatchCompiled);
        for (const p of l.patterns || []) values.push(num(p.headway), +Array.isArray(p.calls));
      }
      const result = ROUTING.kernel('service_validate', Float64Array.from(values));
      return result[0] === 1 && result[1] === 1;
    } catch {
      return false;
    }
  }

  function network(s) {
    const adj = Editor.query(s, 'graph');
    ROUTING.prepare(s, adj);
    return adj;
  }

  // Search implementation is Rust-only; JS preserves the existing public object contract.
  const ROUTING = typeof module !== 'undefined' && module.exports ? require('./routing-wasm') : root
    .RailRouting;

  function paths(s, adj, origin, value = .045, firstKey = null) {
    return ROUTING.paths(s, adj, origin, value, firstKey);
  }

  function compactPaths(s, adj, origin, value = .045, firstKey = null) {
    return ROUTING.compactPaths(s, adj, origin, value, firstKey);
  }

  function pathAt(tree, destination) {
    return ROUTING.pathAt(tree, destination);
  }
  const VOT = {
    work: 40,
    shopping: 25,
    leisure: 20
  };

  function modeShare({
    purpose,
    minutes,
    walk,
    fare: price,
    km
  }) {
    const v = Editor.numeric(8, [purpose === 'work' ? 0 : purpose === 'leisure' ? 2 : 1, minutes, walk,
      price, km
    ]);
    return {
      share: v[1],
      railCost: v[2],
      alternativeCost: v[3]
    };
  }
  const api = {
    loopDwell,
    directionName,
    smooth,
    rawTrackPoints,
    geometry,
    directions,
    TRANSFER,
    get tariffs(){return planningView().settings().tariffs;},
    get LIMITS(){return planningView().settings().tariffs.limits;},
    get PRICES(){return planningView().settings().tariffs.prices;},
    lineSettings,
    feedbackFares,
    KINDS,
    VOT,
    distance,
    trackPoints,
    linePoints,
    along,
    sum,
    draftLegs,
    fare,
    patterns,
    patternDraft,
    compile,
    expand,
    duration,
    headway,
    validate,
    network,
    paths,
    compactPaths,
    pathAt,
    routingStatus: ROUTING.status,
    modeShare
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailServicePlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
