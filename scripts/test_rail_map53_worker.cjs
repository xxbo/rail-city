const assert=require('node:assert/strict');
const P=require('../rail/passengers'),M=require('./helpers/management-compat.cjs'),D=require('../rail/demand-model'),N=require('../rail/network');
const OldP=require('./fixtures/rail-map52-passengers.cjs'),OldM=require('./fixtures/rail-map52-management.cjs');
const U=require('../rail/urban-growth'),RV=require('../rail/operations-review');
const {create}=require('./fixtures/rail-memory-grid.cjs');
let checks=0;
function forecast(s) {
  const cells = s.nodes.map((n, i) => ({
    id: 'c' + i,
    x: n.x,
    y: n.y,
    w: 8,
    h: 8,
    area: .13,
    people: 18000 + i * 500,
    jobs: 12000 + i * 200,
    shops: 5000,
    industry: 500,
    leisure: 1000
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

const Oracle=require('./helpers/native-oracle.cjs');
function pair(start=480,weighted=false){
 const a=create(3);a.economy.cash=5e10;a.economy.minute=start;a.economy.nextLoan=2;
 a.economy.loans=[{id:1,initial:1e8,principal:1e8,interest:20,installment:1e8/30,nextDue:start+.135}];
 U.init(a);a.urban.lastMinute=Math.max(420,start-360+.2);RV.init(a,{minute:start});
 const b=structuredClone(a),f=forecast(a),ra=Oracle.create(P,a,f,start,weighted),rb=OldP.create(b,f,start,false);if(weighted)rb.arrivalMode='weighted';return {a,b,f,ra,rb};
}

(async()=>{
 for(const weighted of [false,true])for(const start of [419.83,539.83,1139.83,1439.83,1859.85]) {
  const p=pair(start,weighted);
  try {
   for(let i=0;i<8;i++) {
    const minutes=i%2?2.37:1.3;
    const result=await M.advanceBudgetAsync(p.a,p.ra,minutes,{budget:1e6,maxSteps:10000,now:()=>0});
    let remaining=minutes;while(remaining>1e-8){const dt=Math.min(.1,remaining);OldM.advance(p.b,p.rb,dt);remaining-=dt;}
    Oracle.world(p.a,p.b);Oracle.checkpoint(await P.snapshotAsync(p.ra),OldP.snapshot(p.rb),p.rb.defs,p.a);assert.equal(result.remaining,remaining);checks++;
    if(i===2||i===5) {
     const dispatch={mode:'auto',manual:8,offPeak:i===2?0:4,peak:8};
     for(const line of [...p.a.services]){const result=await M.changeAsync(p.a,p.ra,{kind:'network',op:'configure',args:{id:line.id,values:{dispatch}}});assert(!result.error,result.error);const mark=RV.prepare(p.b,p.rb);assert(!OldM.change(p.b,state=>N.configure(state,line.id,{dispatch})).error);OldP.reconcile(p.rb,p.b);RV.record(p.b,p.rb,mark);}
     OldP.reconcile(p.rb,p.b);
    }
   }
  }finally{P.dispose(p.ra);OldP.dispose?.(p.rb);}
 }
 console.log(`MAP53 worker: ${checks} frozen MAP52 complete checkpoints; transferable cycle/loop, loans, peak/day/city/review, edits and weighted/integer demand.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
