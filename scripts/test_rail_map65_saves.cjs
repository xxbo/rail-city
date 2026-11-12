/* P2-4: frozen save/restore semantics and stronger file rejection before import. */
const assert=require('node:assert/strict'),N=require('../rail/network'),M=require('./helpers/management-compat.cjs'),U=require('../rail/urban-growth'),D=require('../rail/demand-model'),P=require('../rail/passengers'),LS=require('../rail/local-save'),Save=require('../rail/save-wasm'),Core=require('../rail/routing-wasm');
const OldLS=require('./fixtures/rail-map64-local-save.cjs'),OldP=require('./fixtures/rail-map64-passengers.cjs'),OldU=require('./fixtures/rail-map64-urban-growth.cjs'),OldM=require('./fixtures/rail-map64-management.cjs'),OldDev=require('./fixtures/rail-map64-city-development.cjs');
let checks=0;const clone=structuredClone;function exact(a,b,label){assert.deepEqual(a,b,label);assert.equal(JSON.stringify(a),JSON.stringify(b),label+' order');checks++;}
// Pin the historical management loop to its matching passenger implementation;
// its original CommonJS import otherwise resolves today's detached native facade.
const Module=require('node:module'),fs=require('node:fs');
const oldManagementPath=require.resolve('./fixtures/rail-map64-management.cjs'),frozenModule=new Module(oldManagementPath,module);
frozenModule.filename=oldManagementPath;frozenModule.paths=module.paths;
frozenModule._compile(fs.readFileSync(oldManagementPath,'utf8').replace("require('../../rail/passengers')","require('./rail-map64-passengers.cjs')"),oldManagementPath);
const HistoricalManagement=frozenModule.exports;
// Compare every legacy business field. Native round trips above retain their
// exact property order; independent clock arithmetic uses an absolute tolerance.
function historical(a,b,label){
 function compare(x,y,field){
  if(typeof x==='number'&&typeof y==='number'&&(!Number.isInteger(x)||!Number.isInteger(y))){assert(Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<1e-7,label+' '+field+' '+x+' != '+y);return;}
  if(x&&y&&typeof x==='object'&&typeof y==='object'){assert.deepEqual(Object.keys(x).sort(),Object.keys(y).sort(),label+' keys '+field);for(const key of Object.keys(y))compare(x[key],y[key],field+'.'+key);return;}
  assert.deepEqual(x,y,label+' '+field);
 }compare(a,b,'');checks++;
}
function legacyCheckpoint(actual,expected,label){
 assert.equal(actual.demandStatus.storage,'native');assert.equal(actual.nativeEditRevision,0);assert.equal(actual.nativeCommandSerial,0);
 assert.equal(actual.storedProfiles,actual.urbanDefs.length);assert(Number.isInteger(actual.nativeSerial)&&actual.nativeSerial>=0);
 assert.equal(typeof actual.forecastStatus.dirty,'boolean');assert(Number.isFinite(actual.forecastView.covered));
 exact(LS.records(actual.personalRecords),actual.personalRecords,'native records');
 const {forecastView,personalRecords,nativeSerial,storedProfiles,forecastStatus,nativeEditRevision,nativeCommandSerial,urbanDefs,...a}=clone(actual),b=clone(expected);
 a.demandStatus.storage='lazy';
 for(const value of [a,b])for(const key of Object.keys(value.blocks))if(value.blocks[key]===0)delete value.blocks[key];
 // Only admission limits belong to the runtime DTO; geometry is derived UI data.
 for(const value of [a,b])for(const [id,row]of Object.entries(value.stationLimits))value.stationLimits[id]={capacity:row.capacity,outsideCapacity:row.outsideCapacity};
 historical(a,b,label);
}
function legacyWorld(actual,expected,label){
 assert.equal(actual.routeModel,1);assert.deepEqual(actual.ridership.lines,{},'weighted worlds have no modern cultivation feedback');
 const b=clone(expected);for(const row of Object.values(b.ridership.lines)){for(const key of ['awareness','trust'])assert(Number.isFinite(row[key])&&row[key]>=0&&row[key]<=1);assert(Number.isFinite(row.serviceDays)&&row.serviceDays>=0);}
 b.ridership.lines={};historical(actual,b,label);
}
function fixture(region,modern,urban){const s=M.init(N.emptyWorld(region));if(modern)N.upgrade(s);else s.routeModel=1;const built=N.addLine(s,[{x:600,y:500},{x:640,y:500},{x:680,y:500}],modern?{stockSpec:'6B'}:null);assert(!built.error);assert(s.services.length);if(modern){require('../rail/fleet').purchase(s,'6B',8);N.configure(s,s.services[0].id,{dispatch:{mode:'manual',manual:8,offPeak:8,peak:8}});}if(urban)U.init(s);const fields=['people','jobs','shops','industry','leisure'],cells=s.nodes.map((n,i)=>({id:'c'+i,x:n.x,y:n.y,w:8,h:8,area:.13,people:3000+i*200,jobs:1500+i*100,shops:500,industry:50,leisure:200})),m=D.evaluate(s,{cells,totals:Object.fromEntries(fields.map(k=>[k,cells.reduce((v,c)=>v+c[k],0)])),metadata:{effectiveConnections:true,demandZoneUnits:40}},{compact:true});return {s,m};}
for(const region of ['tokyo','gba'])for(const modern of [false,true])for(const urban of [false,true]){
 const {s,m}=fixture(region,modern,urban),rt=P.create(s,m,480,false);M.advance(s,rt,30);const saved=JSON.parse(JSON.stringify(P.snapshot(rt)));
 exact(M.signature(s),OldM.signature(s),'signature');exact(U.validate(s),OldU.validate(s),'urban');exact(require('../rail/city-development').valid(s),OldDev.valid(s),'development');
 const a=P.restore(s,m,clone(saved)),b=OldP.restore(s,m,clone(saved));assert(a&&b,'valid runtime restores');assert.equal(a.demandStatus.storage,'native');assert.equal(a.demandStatus.updatedAt,saved.demandStatus.updatedAt);b.demandStatus.storage='native';b.demandStatus.updatedAt=saved.demandStatus.updatedAt;exact(P.snapshot(a),saved,'complete ordered native restore');exact(P.snapshot(a),OldP.snapshot(b),'complete restored snapshot');const summary=P.demandSummary(a),legacySummary=OldP.demandSummary(b);exact(Object.fromEntries(Object.keys(legacySummary).map(key=>[key,summary[key]])),legacySummary,'catalog');
 const before=JSON.stringify(s),file=OldLS.pack(s,saved,{speed:12,personalRecords:{bestDay:15,bestHour:-1}});exact(LS.parse(JSON.stringify(file)),OldLS.parse(JSON.stringify(file)),'old file');assert.equal(JSON.stringify(s),before);
 const fresh=LS.pack(s,saved,{speed:12,playing:true});assert.equal(fresh.runtimeVersion,1);assert.equal(LS.parse(JSON.stringify(fresh)).playing,false);checks++;
 for(const minute of [480,1440,1860]){const c=clone(s);c.economy.minute=minute;exact(M.signature(c),OldM.signature(c),'clock independent signature');}
 for(const edit of [x=>x.generated+=100,x=>x.minute=NaN,x=>x.trains=[],x=>x.stationOccupancy={999:1},x=>x.outside={'999':{'0:0':1}},x=>x.transfers=[{journey:999999,leg:0,station:0,amount:1,ready:500}],x=>x.queues={'invalid':{}},x=>x.arrivalMode='integer'&&(x.rngState=-1)]){const bad=clone(saved);edit(bad);exact(!!P.restore(s,m,bad),!!OldP.restore(s,m,bad),'corrupt runtime parity');}
 if(urban){const bad=clone(file);bad.runtime.generated+=100;assert.throws(()=>LS.parse(JSON.stringify(bad)),/运行数据/);assert.doesNotThrow(()=>OldLS.parse(JSON.stringify(bad)));checks++;}
 for(const field of ['formatVersion','gameVersion','region']){const bad=clone(file);bad[field]='unsupported';let e1,e2;try{LS.parse(JSON.stringify(bad));}catch(e){e1=e.message;}try{OldLS.parse(JSON.stringify(bad));}catch(e){e2=e.message;}exact(e1,e2,'file rejection');}
 // Corrupt passenger counts are rejected at file acceptance even in historical nonurban files.
 const wrong=clone(file);wrong.runtime.generated+=100;assert.throws(()=>LS.parse(JSON.stringify(wrong)),/运行数据/);checks++;
 if(saved.trains.length){const bad=clone(file);bad.runtime.trains[0].onboard+=1;assert.throws(()=>LS.parse(JSON.stringify(bad)),/运行数据/);assert.equal(P.restore(s,m,bad.runtime),null);checks+=2;}
 const bare=clone(file);delete bare.format;delete bare.formatVersion;exact(LS.parse(JSON.stringify(bare)),OldLS.parse(JSON.stringify(bare)),'legacy bare envelope');
 const unknown=clone(fresh);unknown.runtimeVersion=2;assert.throws(()=>LS.parse(JSON.stringify(unknown)),/版本/);checks++;
 Core.recycleSimulation();exact(M.signature(s),OldM.signature(s),'recycled signature');assert(P.restore(s,m,saved));checks++;
}
for(const value of [{bestDay:NaN,bestHour:0,totalCompleted:4,bestRevenue:-1},{bestRevenue:Infinity,bestLineKm:-0,totalPassengerKm:10},{}])exact(LS.records(value),OldLS.records(value),'record filtering');
let deep={};for(let i=0;i<100;i++)deep={deep};assert.throws(()=>LS.parse(JSON.stringify({gameVersion:7,state:{region:'gba'},deep})),/过大|过深/);checks++;
const atomic=fixture('gba',true,true),ar=P.create(atomic.s,atomic.m,480,false);M.advance(atomic.s,ar,1);const originalPlan=require('../rail/service-plan').expand(atomic.s),planBefore=JSON.stringify(originalPlan),badPlan=JSON.parse(JSON.stringify(P.snapshot(ar)));badPlan.generated+=100;badPlan.routeArchives={fake:{tracks:[]}};assert.equal(P.restore(atomic.s,atomic.m,badPlan),null);assert.equal(JSON.stringify(originalPlan),planBefore);checks++;
const urbanFixture=fixture('gba',true,true).s;
for(const [field,values]of Object.entries({revision:[-1,1.2,Infinity,0],step:[-1,.5,0],nextId:[-1,0,2],started:[0,420,Infinity],lastMinute:[419,420]}))for(const value of values){const s=clone(urbanFixture);s.urban[field]=value;exact(U.validate(s),OldU.validate(s),'urban guard '+field);}
for(const value of [null,{},[],{version:35,started:420,projects:[]},{version:35,started:420,projects:[{id:'a',name:'住宅😀',kind:'residential',x:600,y:500,radius:2,startDay:0}]}]){const s=clone(urbanFixture);s.urban.development=value;exact(require('../rail/city-development').valid(s),OldDev.valid(s),'development legacy guards');}
// The historical streaming identity adapter now applies native windows/spawn decisions.
for(const start of [419.9,479.9,539.9,1439.9,1859.9]){const {s,m}=fixture('gba',false,false);s.services[0].open=480.1;s.services[0].close=540.2;const a=clone(s),b=clone(s),ra=P.create(a,m,start,false),rb=OldP.create(b,m,start,false);for(let i=0;i<12;i++){P.advance(ra,a,.1);HistoricalManagement.advance(b,rb,.1);legacyCheckpoint(P.snapshot(ra),OldP.snapshot(rb),'weighted native window/spawn');legacyWorld(a,b,'weighted complete state');}P.dispose(ra);OldP.dispose(rb);}
for(const version of [true,null,'1',2]){const {s}=fixture('gba',true,true),file=LS.pack(s,null);file.runtimeVersion=version;assert.throws(()=>LS.parse(JSON.stringify(file)),/版本/);checks++;}
const {s:finiteState}=fixture('gba',true,true),finiteFile=LS.pack(finiteState,null);finiteFile.extra='sentinel';const overflow=JSON.stringify(finiteFile).replace('"sentinel"','1e309');assert.throws(()=>LS.parse(overflow),/无效数值/);checks++;
for(const version of [undefined,1,2,true]){const {s,m}=fixture('gba',true,true),rt=P.create(s,m,480,false);M.advance(s,rt,1);const v=LS.pack(s,P.snapshot(rt));if(version===undefined)delete v.runtimeVersion;else v.runtimeVersion=version;const r=Save.run('checkpoint',{value:v,region:'gba'});assert.equal(r.valid,version===undefined||version===1);assert.equal(r.useRuntime,r.valid);assert.equal(Save.run('checkpoint',{value:v,region:'tokyo'}).valid,false);checks+=3;}
for(const kind of [0,6,7]){const {s}=fixture('gba',true,true),v=kind?{gameVersion:kind,state:s}:s,r=Save.run('checkpoint',{value:v,region:'gba'});assert(r.valid);assert.equal(r.kind,kind);checks+=2;}
{const {s,m}=fixture('gba',false,false);const ring=N.addLine(s,[0,1,2,0]);assert(!ring.error);assert(!N.configure(s,ring.id,{loopDirection:'forward',headway:4}).error);const a=clone(s),b=clone(s),ra=P.create(a,m,480,false),rb=OldP.create(b,m,480,false);for(let i=0;i<20;i++){P.advance(ra,a,.5);HistoricalManagement.advance(b,rb,.5);legacyCheckpoint(P.snapshot(ra),OldP.snapshot(rb),'weighted loop spawn');legacyWorld(a,b,'weighted loop state');}P.dispose(ra);OldP.dispose(rb);}
{const {s,m}=fixture('gba',true,true),rt=P.create(s,m,480,false);M.advance(s,rt,1);const saved=JSON.parse(JSON.stringify(P.snapshot(rt))),Catalog=require('../rail/forecast-catalog'),guarded=Catalog.adopt({population:m.population,catchment:m.catchment,get flows(){throw Error('full forecast view read during restore');}}, {...Catalog.source(m)});let restored;try{restored=P.restore(s,guarded,saved);assert(restored);exact(P.snapshot(restored),saved,'handle-only ordered restore');checks++;}finally{P.dispose(rt);if(restored)P.dispose(restored);}}
console.log(`MAP65 P2-4: ${checks} frozen file/signature/restore checks; both maps, modern/weighted, urban/nonurban, old envelopes, version guards, corrupt imports, complete snapshots and native recovery.`);
