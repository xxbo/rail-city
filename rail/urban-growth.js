/* Transit-led cellular urban development. Behavioural coefficients, thresholds and clock are game rules. */
(function(root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports,
    H = node ? require('./hubs') : root.RailHubs,
    F = node ? require('./fleet') : root.RailFleet,
    D = node ? require('./city-development') : root.RailDevelopment;
  const VERSION = 19,
    STEP = 360,
    SIZE = 12,
    AREA = (SIZE * .045) ** 2,
    FIELDS = ['people', 'jobs', 'shops', 'industry', 'leisure'];
  const TYPES=new Proxy({}, {get:(_,key)=>(node?require('./bootstrap-wasm'):root.RailBootstrap).settings().types[key],ownKeys:()=>Object.keys((node?require('./bootstrap-wasm'):root.RailBootstrap).settings().types),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});

  function native(op,s,extra={}) {
    const T=node?require('./transactions-wasm'):root.RailTransactions;
    let urban=s.urban;
    if(op===1)urban={...urban,cells:Object.fromEntries(Object.entries(urban.cells).map(([id,c])=>[id,{...c,...(Object.hasOwn(c,'scores')?{scores:null}:{}),...(Object.hasOwn(c,'levels')?{levels:null}:{})}]))};
    if(op===12)urban={facilityMode:urban.facilityMode,facilities:urban.facilities,development:urban.development,lastMinute:urban.lastMinute};
    if(op===13||op===15||op===11)urban={};
    if(op===0||op===2||op===4||op===14)urban={...urban,cells:Object.fromEntries(Object.entries(urban.cells).map(([id,c])=>[id,{x:c.x,y:c.y,r:c.r,c:c.c,i:c.i}]))};
    return T.run(op,{state:{urban,services:s.services,nodes:s.nodes,economy:{minute:s.economy?.minute??420}},types:TYPES,
      hubs:H.forRegion(s.region).map(h=>({...h,daily:H.daily(h)})),...extra});
  }
  function adopt(u,v){Object.assign(u,v);}
  function cityProjection(s,v){v.cells=v.cells.map(c=>({id:c.id,...s.urban.cells[c.id],...c}));return v;}
  function needRate(kind) {
    return TYPES[kind].needRate ?? (kind === 'school' ? .12 : kind === 'hospital' ? .025 : .05);
  }
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
    dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * .045,
    cache = new WeakMap();

  function init(s){if(!s.urban)s.urban=(node?require('./bootstrap-wasm'):root.RailBootstrap).run('urbanInit',{state:{economy:s.economy}});return s.urban;}
  // Automatic city destinations are deterministic game facilities, not a real POI inventory.
  function enableAutomatic(s, base, places = []) {
    const u = init(s);
    if (u.facilityMode === 'automatic') return false;
    assets().mutate(s,'municipalTransfer');
    const anchors = [],
      hubs = H.forRegion(s.region),
      source = (places.length ? places : base.cells.filter(c => c.people > 100).sort((a, b) => b.people - a
        .people)).filter(p => buildable(s, base, p) && !hubs.some(h => dist(h, p) < .25)).map(p => ({
        x: p.x,
        y: p.y,
        name: p.name || '城市片区'
      }));
    u.autoCandidates=native(11,s,{places:source});
    u.facilityMode = 'automatic';
    u.revision++;
    autoFacilities(s);
    return true;
  }

  function autoFacilities(s) {
    if(!s.urban)return;const result=native(4,s);adopt(s.urban,result);
  }

  function enableDevelopment(s, base, places = []) {
    return D.enable(s, base, places, H.forRegion(s.region), p => buildable(s, base, p));
  }

  function developmentSummary(s) {
    return D.summary(s, stations(s));
  }

  function connection(s, f) {
    const v=native(15,s,{facility:f});return {...v,status:v.connected?'已接驳':v.nearest&&v.nearest.walk<=.8?'车站未投放列车':'待接驳'};
  }

  function validate(s) {return (node?require('./save-wasm'):root.RailSave).run('urban',{state:s});}

  function terrain(base,p){const B=node?require('./bootstrap-wasm'):root.RailBootstrap;return B.run('terrain',{...B.geo(base),point:p});}
  function buildable(s,base,p){const B=node?require('./bootstrap-wasm'):root.RailBootstrap;return B.run('buildable',{state:{region:s.region,world:s.world},point:p,...B.geo(base)});}

  const assets = () => node ? require('./assets-wasm') : root.RailAssets;
  const facilitiesValue = s => assets().query(s,'facilityValue');
  function plan(s,base,kind,p) { return assets().mutate(s,'plan',{kind,point:p,land:buildable(s,base,p)}); }
  const upgrade = (s,id) => assets().mutate(s,'upgradeFacility',{id});
  const remove = (s,id) => assets().mutate(s,'removeFacility',{id});

  function stations(s) {
    return native(13,s);
  }

  function zone(s, p, ctx = null) {
    init(s);return native(2,s,{point:p});
  }
  // Local neighbourhood queries use a bounded candidate grid. No whole-map population is seeded.
  function candidates(s, base) {
    const keys=new Set(Object.keys(s.urban.cells));for(const p of native(12,s))if(buildable(s,base,p))keys.add(Math.floor(p.x/SIZE)+':'+Math.floor(p.y/SIZE));return [...keys].slice(0,24000);
  }

  function step(s, base) {
    init(s);const first=native(0,s);adopt(s.urban,first.urban);
    const keys=new Set(Object.keys(s.urban.cells));
    for(const p of first.points)if(buildable(s,base,p))keys.add(Math.floor(p.x/SIZE)+':'+Math.floor(p.y/SIZE));
    const result=native(1,s,{keys:[...keys].slice(0,24000),metadata:base.metadata});
    adopt(s.urban,result.urban);cache.set(s.urban,{revision:s.urban.revision,city:cityProjection(s,result.city)});return result.growth;
  }

  function advance(s, base, minute) {
    if (!s.urban) return false;
    const u = s.urban;
    let changed = false;
    while (minute - u.lastMinute >= STEP - 1e-7) {
      step(s, base);
      changed = true;
    }
    return changed;
  }

  function city(s, base) {
    if(!s.urban)return base;const prior=cache.get(s.urban);if(prior?.revision===s.urban.revision)return prior.city;
    const result=cityProjection(s,native(3,s,{metadata:base.metadata}));cache.set(s.urban,{revision:s.urban.revision,city:result});return result;
  }

  function facilityStats(s, f) {
    return native(14,s,{facility:f});
  }

  function upkeep(s) {
    return facilitiesValue(s) * .001;
  }
  const LAND_USES = {
    r: {
      label: '住',
      name: '住宅',
      color: '#4e9b83'
    },
    c: {
      label: '商',
      name: '商业',
      color: '#d99542'
    },
    i: {
      label: '工',
      name: '工业',
      color: '#9578be'
    }
  };

  function markers(cells, scale = 1) {
    const bin = Math.max(SIZE, 30 / Math.max(.001, scale)),
      groups = new Map();
    for (const c of cells) {
      const key = Math.floor(c.x / bin) + ':' + Math.floor(c.y / bin);
      let g = groups.get(key);
      if (!g) groups.set(key, g = {
        key,
        x: 0,
        y: 0,
        weight: 0,
        r: 0,
        c: 0,
        i: 0,
        area: 0,
        people: 0,
        jobs: 0
      });
      const amount = c.people + c.jobs;
      if (amount < 2) continue;
      g.x += c.x * amount;
      g.y += c.y * amount;
      g.weight += amount;
      g.r += c.people;
      g.c += Math.max(0, c.jobs - c.industry);
      g.i += c.industry;
      g.people += c.people;
      g.jobs += c.jobs;
      g.area += c.area;
    }
    const out = [];
    for (const g of groups.values()) {
      if (!g.weight) continue;
      g.x /= g.weight;
      g.y /= g.weight;
      const max = Math.max(g.r, g.c, g.i),
        kinds = Object.keys(LAND_USES).filter(k => g[k] >= Math.max(30, max * .15));
      for (const [i, kind] of kinds.entries()) {
        const hash = Math.sin(g.x * 12.9898 + g.y * 78.233 + i * 17.17) * 43758.5453,
          angle = (hash - Math.floor(hash)) * Math.PI * 2,
          offset = kinds.length > 1 ? Math.min(bin * .23, 11 / Math.max(.001, scale)) : Math.min(bin * .12,
            4 / Math.max(.001, scale));
        out.push({
          ...g,
          key: g.key + '|' + kind,
          kind,
          ...LAND_USES[kind],
          amount: g[kind],
          x: g.x + Math.cos(angle) * offset,
          y: g.y + Math.sin(angle) * offset
        });
      }
    }
    return out;
  }
  const api = {
    enableDevelopment,
    developmentSummary,
    developmentKinds: D.KINDS,
    VERSION,
    STEP,
    SIZE,
    AREA,
    TYPES,
    enableAutomatic,
    autoFacilities,
    connection,
    LAND_USES,
    markers,
    init,
    validate,
    terrain,
    buildable,
    plan,
    upgrade,
    remove,
    facilitiesValue,
    stations,
    zone,
    candidates,
    step,
    advance,
    city,
    facilityStats,
    upkeep
  };
  if (node) module.exports = api;
  else root.RailUrban = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
