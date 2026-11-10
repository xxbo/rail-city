/* Regional development opportunities and finite inflow. All coefficients are game rules. */
(function(root) {
  'use strict';
  const VERSION = 35,
    USES = ['r', 'c', 'i'],
    clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
    distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * .045;
  const KINDS=new Proxy({}, {get:(_,key)=>(typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap).settings().developmentKinds[key],ownKeys:()=>Object.keys((typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap).settings().developmentKinds),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});

  const native=(op,s,extra={})=>(typeof module!=='undefined'&&module.exports?require('./transactions-wasm'):root.RailTransactions).run(op,{state:{urban:{lastMinute:s.urban.lastMinute,development:s.urban.development,totals:s.urban.totals}},...extra});
  function enable(s, base, places, hubs, buildable) {
    if(!s.urban||s.urban.development)return false;s.urban.development=native(10,s,{region:s.region,places:places.filter(buildable),hubs});s.urban.revision++;return true;
  }

  function valid(s) {return (typeof module!=='undefined'&&module.exports?require('./save-wasm'):root.RailSave).run('development',{state:s});}

  function phase(s, p) {
    const v=native(5,s,{point:p});return {day:v.day,age:v.age,release:v.release,label:v.age<0?'筹备中':v.age<6?'启动建设':v.age<18?'持续建设':'成熟片区',until:v.until};
  }
  const potentialCache = new WeakMap();

  function potential(s, p) {
    return native(6,s,{point:p});
  }

  function score(s, p, v) {
    return native(7,s,{point:p,scores:v});
  }

  function budgets(s) {
    return native(8,s);
  }

  function allocate(s, before, updates) {
    const v=native(9,s,{before,updates});for(const [key,c]of Object.entries(v.updates))Object.assign(updates[key],c);s.urban.development.last=v.last;return v.added;
  }
  const summaryCache = new WeakMap();

  function summary(s, stations) {
    const u = s.urban,
      d = u?.development;
    if (!d) return null;
    const key = stations.map(n => n.id + ':' + n.name + ':' + n.x + ':' + n.y + ':' + n.service).join(','),
      cached = summaryCache.get(u);
    if (cached?.revision === u.revision && cached.key === key) return cached.value;
    const cells = Object.values(u.cells),
      projects = d.projects.map(p => {
        const stage = phase(s, p),
          near = stations.map(n => ({
            id: n.id,
            name: n.name,
            walk: distance(n, p) * 1.25,
            service: n.service
          })).sort((a, b) => a.walk - b.walk),
          nearest = near[0],
          served = near.some(n => n.walk <= .8 && n.service === 1),
          nearby = cells.filter(c => distance(c, p) <= p.radius),
          population = nearby.reduce((a, c) => a + c.r, 0),
          jobs = nearby.reduce((a, c) => a + c.c + c.i, 0);
        return {
          ...p,
          ...stage,
          nearest,
          served,
          population,
          jobs,
          priority: stage.release * (served ? .15 : 1) / (1 + (nearest?.walk || 0) / 6)
        };
      }).sort((a, b) => b.priority - a.priority || a.startDay - b.startDay),
      value = {
        projects,
        daily: budgets(s),
        last: d.last,
        started: d.started
      };
    summaryCache.set(u, {
      revision: u.revision,
      key,
      value
    });
    return value;
  }
  const api = {
    VERSION,
    KINDS,
    enable,
    valid,
    phase,
    potential,
    score,
    budgets,
    allocate,
    summary
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailDevelopment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
