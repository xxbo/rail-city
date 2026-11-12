/* Frozen MAP44 oracle for native queue ownership and ordered event continuation. */
const assert = require('node:assert/strict');
const P = require('../rail/passengers'),
  Old = require('./fixtures/rail-map50-passengers.cjs');
const M = require('./helpers/management-compat.cjs'),
  OldM = require('./fixtures/rail-map50-management.cjs');
const N = require('../rail/network'),
  D = require('../rail/demand-model');
const {
  create
} = require('./fixtures/rail-memory-grid.cjs');
let checkpoints = 0;
const runtimes=[];
const Oracle=require('./helpers/native-oracle.cjs');

function forecast(s) {
  const cells = s.nodes.map((n, i) => ({
    id: 'c' + i,
    x: n.x,
    y: n.y,
    w: 8,
    h: 8,
    area: .13,
    people: 3000000,
    jobs: 2000000,
    shops: 1000000,
    industry: 500,
    leisure: 10000
  }));
  return D.evaluate(s, {
    cells,
    totals: Object.fromEntries(['people', 'jobs', 'shops', 'industry', 'leisure'].map(k => [k,
      cells.reduce((v, c) => v + c[k], 0)
    ])),
    metadata: {
      effectiveConnections: true,
      demandZoneUnits: 40
    }
  });
}

function pair(weighted = false) {
  const a = create(3),
    b = structuredClone(a),
    f = forecast(a);
  const ra = Oracle.create(P,a,f,480,weighted), rb = Old.create(b,f,480,false);if(weighted)rb.arrivalMode='weighted';
  return {
    a,
    b,
    f,
    ra,
    rb
  };
}

async function step(p,dt) {
  const actual=await M.advanceBudgetAsync(p.a,p.ra,dt,{budget:1e6,maxSteps:10000,now:()=>0});
  const expected=OldM.advanceBudget(p.b,p.rb,dt,{budget:1e6,maxSteps:10000,now:()=>0});
  Oracle.batch(actual,expected);Oracle.world(p.a,p.b);
  Oracle.checkpoint(await P.snapshotAsync(p.ra),Old.snapshot(p.rb),p.rb.defs,p.a);checkpoints++;
}
(async()=>{
for (const weighted of [false, true]) {
  const p = pair(weighted);runtimes.push(p.ra);
  for (let i = 0; i < 90; i++) await step(p, .5);
  assert(p.ra.rejected > 0);
  assert(p.ra.completed > 0);
  // Editing a populated network retains incumbent fares and retires old train geometry.
  const line=p.a.services[0],removed=await M.changeAsync(p.a,p.ra,{kind:'network',op:'removeStation',args:{id:line.id,nodeId:line.stops[1]}});assert(!removed.error,removed.error);
  assert(!OldM.change(p.b,state=>N.removeStation(state,state.services[0].id,state.services[0].stops[1])).error);Old.reconcile(p.rb,p.b);
  for (let i = 0; i < 50; i++) await step(p, .5);
  const id=p.a.services[2].id,deleted=await M.changeAsync(p.a,p.ra,{kind:'network',op:'removeLine',args:{id}});assert(!deleted.error,deleted.error);
  assert(!OldM.change(p.b,state=>N.removeLine(state,id)).error);Old.reconcile(p.rb,p.b);
  for (let i = 0; i < 40; i++) await step(p, .5);
  // Full archive replacement triggers a native reload without resetting queues or counters.
  await M.replaceDemandAsync(p.ra,forecast(p.a));
  Old.rebase(p.rb, p.b, forecast(p.b));
  for (let i = 0; i < 20; i++) await step(p, .5);
  P.dispose(p.ra);Old.dispose?.(p.rb);
}
console.log(`MAP51 worker queues: ${checkpoints} exact complete states; crowding, retiring trains, station/line removal, reroutes and archive rebase.`);
})().catch(error=>{console.error(error);for(const rt of runtimes)P.dispose(rt);process.exitCode=1;});
