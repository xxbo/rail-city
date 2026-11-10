/* Frozen complete-output parity for the P2-3 rules and actual observation lifecycle. */
const assert=require('node:assert/strict');
const OC=require('../rail/operations-center'),Stats=require('../rail/network-stats'),Alerts=require('../rail/alerts'),Review=require('../rail/operations-review'),Metrics=require('../rail/metrics');
const OldOC=require('./fixtures/rail-map63-operations-center.cjs'),OldStats=require('./fixtures/rail-map63-network-stats.cjs'),OldAlerts=require('./fixtures/rail-map63-alerts.cjs'),OldReview=require('./fixtures/rail-map63-operations-review.cjs'),OldMetrics=require('./fixtures/rail-map63-metrics.cjs');
const {create}=require('./fixtures/rail-memory-grid.cjs'),D=require('../rail/demand-model'),X=require('../rail/service-plan'),Core=require('../rail/routing-wasm'),Compact=require('../rail/forecast-catalog');
let checks=0;const clone=structuredClone;
function exact(a,b,label){assert.deepEqual(a,b,label);assert.equal(JSON.stringify(a),JSON.stringify(b),label+' ordered JSON');checks++;}
const s=create(3),fields=['people','jobs','shops','industry','leisure'],cells=s.nodes.map((n,i)=>({id:'c'+i,x:n.x,y:n.y,w:8,h:8,area:.13,people:3000+i*200,jobs:1500+i*100,shops:500,industry:50,leisure:200})),city={cells,totals:Object.fromEntries(fields.map(k=>[k,cells.reduce((v,c)=>v+c[k],0)])),metadata:{effectiveConnections:true,demandZoneUnits:40}};
const compact=D.evaluate(s,city,{compact:true}),raw={...compact,flows:Array.from(compact.flows)};delete raw.preparedDefinitions;
for(const f of [raw,compact])for(const model of [undefined,14,22])for(const minute of [419,480,540,720,1140,1430,1870]){
 const state=clone(s);state.ridership.model=model;state.economy.minute=minute;
 for(const r of Object.values(state.ridership.lines)){r.satisfaction=.45;r.awareness=.55;r.trust=.8;}
 const plan=X.expand(state,minute),rt={minute,plan,trains:plan.services.slice(0,3).map((r,i)=>({parentLine:r.parentLine,service:r.id,onboard:i?1300:20,capacity:1440})),queues:{},outside:{},transfers:[]};
 for(const run of plan.services.slice(0,2)){rt.queues[run.id+'|1|'+run.stops[0]]={'0:0':5000,'1:0':350};rt.outside[run.stops[0]]={'1':500};rt.transfers.push({station:run.stops[0],amount:1500});}
 const before=JSON.stringify({state,rt});
 exact([...Stats.all(state,f)],[...OldStats.all(state,f)],'all stats '+model+'/'+minute);
 for(const l of state.services)exact(Stats.line(state,f,l.id),OldStats.line(state,f,l.id),'line stats');
 exact(Metrics.summary(state,f),OldMetrics.summary(state,f),'metrics');
 exact(Alerts.evaluate(state,rt),OldAlerts.evaluate(state,rt),'alerts');
 const rows=OC.analyze(state,f,rt),old=OldOC.analyze(state,f,rt);exact(rows,old,'operations rows '+minute);
 exact(OC.bundle(state,f,rt),{rows:old,metrics:OldMetrics.summary(state,f)},'single-pass bundle');
 for(const row of rows)exact(OC.preview(state,row),OldOC.preview(state,row),'validated preview');
 assert.equal(JSON.stringify({state,rt}),before,'diagnostics read only');
}
// Raw forecast mutation and explicit cultivation line identities remain observable immediately.
const mutable={...raw,flows:raw.flows.slice(0,3).map(f=>({...f,lineIds:[]}))};
for(let i=0;i<4;i++){mutable.flows[0].trips*=1.3;mutable.population=(mutable.population||1)*2;exact([...Stats.all(s,mutable)],[...OldStats.all(s,mutable)],'mutable forecast');}
// Compact data is not reconstructed into full OD objects, even when cultivation changes.
const reads=Compact.status(compact),token=Core.diagnosticToken();OC.bundle(s,compact,{minute:480,trains:[]});const after=Core.diagnosticToken();assert(after);s.ridership.lines[s.services[0].id].satisfaction=.1;exact(OC.bundle(s,compact,{minute:480,trains:[]}),{rows:OldOC.analyze(s,compact,{minute:480,trains:[]}),metrics:OldMetrics.summary(s,compact)},'compact changed cultivation');assert.equal(Core.diagnosticToken(),after);
// A compact diagnostic must work while every full-flow getter is forbidden.
const descriptor=Object.getOwnPropertyDescriptor(compact,'flows');Object.defineProperty(compact,'flows',{configurable:true,get(){throw Error('full OD view read');}});
try{OC.bundle(s,compact,{minute:480,trains:[]});Stats.all(s,compact);Metrics.summary(s,compact);checks+=3;}finally{Object.defineProperty(compact,'flows',descriptor);}
const lengths=[],kernel=Core.kernel;Core.kernel=(name,input,...args)=>{if(name==='diagnostic_run')lengths.push({total:input.length,metadata:1+input[0]});return kernel(name,input,...args);};
try{OC.bundle(s,compact,{minute:480,trains:[]});Core.recycleSimulation();OC.bundle(s,compact,{minute:480,trains:[]});}finally{Core.kernel=kernel;}
assert.equal(lengths[0].total,lengths[0].metadata);assert(lengths[1].total>lengths[1].metadata);checks+=2;
exact(OC.resize([{kind:'local',fleet:2,extra:-0}],4),OldOC.resize([{kind:'local',fleet:2,extra:-0}],4),'JSON signed zero compatibility');
Core.recycleSimulation();exact(OC.analyze(s,compact,{minute:480,trains:[]}),OldOC.analyze(s,compact,{minute:480,trains:[]}),'recycle reload');
for(const total of [0,2,4,6,12,80])for(const count of [1,2,4]){const ps=Array.from({length:count},(_,i)=>({kind:i?'short':'local',from:0,to:2,fleet:(i+1)*2,headway:6}));exact(OC.resize(ps,total),OldOC.resize(ps,total),'stable allocation ties');}
function fake(minute){return {s:{services:[{id:'s1',name:'测试线',stops:[0,1],trackIds:['t1'],dispatch:{mode:'manual',manual:4,offPeak:4,peak:4},open:0,close:1440,stockSpec:'6B'}],ridership:{lines:{s1:{satisfaction:.7}},current:{number:Math.floor((minute-420)/1440)+1,lines:{s1:{boarded:0,completed:0,waitMinutes:0,revenue:0,operating:0}}},history:[]},urban:{totals:{people:1000,jobs:500}}},rt:{minute,trains:[{parentLine:'s1',onboard:90,capacity:100}]}};}
function advance(x,dt,phase){x.rt.minute+=dt;const q=x.s.ridership,num=Math.floor((x.rt.minute-420)/1440)+1;if(q.current.number!==num){q.history.push(clone(q.current));q.current={number:num,lines:{s1:{boarded:0,completed:0,waitMinutes:0,revenue:0,operating:0}}};}const r=q.current.lines.s1;for(const [k,v]of Object.entries({boarded:phase?20:10,completed:phase?16:8,waitMinutes:phase?20:50,revenue:phase?1200:800,operating:phase?300:200}))r[k]+=v*dt/5;x.rt.trains[0].onboard=phase?40:90;q.lines.s1.satisfaction=phase?.9:.7;}
for(const start of [419,420,530,600,1255,1830]){
 const a=fake(start),b=clone(a);let markA,markB;
 function compare(method,argsA=[],argsB=argsA){const ra=Review[method](a.s,...argsA),rb=OldReview[method](b.s,...argsB);exact(ra,rb,'review '+method+'/'+start);exact(a.s,b.s,'review full world');return [ra,rb];}
 compare('init',[a.rt],[b.rt]);
 for(let i=0;i<12;i++){advance(a,5,false);advance(b,5,false);compare('sample',[a.rt],[b.rt]);}
 [markA,markB]=compare('prepare',[a.rt],[b.rt]);a.s.services[0].dispatch.manual=6;b.s.services[0].dispatch.manual=6;compare('record',[a.rt,markA],[b.rt,markB]);compare('ready',[a.rt.minute],[b.rt.minute]);
 const event=a.s.operationsReview.events[0],oldEvent=b.s.operationsReview.events[0];
 for(let i=0;i<20;i++){advance(a,5,true);advance(b,5,true);compare('sample',[a.rt],[b.rt]);exact(Review.view(event),OldReview.view(oldEvent),'live event reference');}
 exact(Review.valid(a.s),OldReview.valid(b.s),'review validation');
 compare('observe',[a.rt,'s1'],[b.rt,'s1']);compare('ready',[a.rt.minute],[b.rt.minute]);advance(a,60,false);advance(b,60,false);compare('sample',[a.rt],[b.rt]);
 for(let i=0;i<25;i++)compare('observe',[a.rt,'s1'],[b.rt,'s1']);
 for(const field of ['nextAt','nextId','revision']){const x=clone(a.s);x.operationsReview[field]=Infinity;exact(Review.valid(x),OldReview.valid(x),'corrupt review '+field);}
}
console.log(`MAP64 P2-3: ${checks} complete frozen diagnostic/statistic/alarm/preview/review checks passed; raw/compact, cultivation edits, temporal boundaries, live references, read-only worlds and module recovery.`);
