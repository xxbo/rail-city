const assert=require('node:assert/strict'),P=require('../rail/passengers'),M=require('./helpers/management-compat.cjs'),N=require('../rail/network'),Q=require('../rail/ridership'),LS=require('../rail/local-save');
const OldP=require('./fixtures/rail-map56-passengers.cjs'),OldM=require('./fixtures/rail-map56-management.cjs');
const options={budget:1e6,maxSteps:10000,now:()=>0};
// The native loop publishes new review/checkpoint metadata. Frozen business fields
// still compare exactly; only independently accumulated clock values use a tolerance.
function historical(actual,expected,label){
 const a=structuredClone(actual),b=structuredClone(expected);
 function clocks(x,y,key=''){
  if(typeof x==='number'&&typeof y==='number'&&['minute','lastMinute','through'].includes(key)){
   assert(Math.abs(x-y)<1e-6,label+' clock '+key);return y;
  }
  if(x&&y&&typeof x==='object'&&typeof y==='object')for(const k of Object.keys(y))if(Object.hasOwn(x,k))x[k]=clocks(x[k],y[k],k);
  return x;
 }
 assert.deepEqual(clocks(a,b),b,label);
}
function world(actual,expected,label){
 assert.equal(actual.operationsReview.version,1);assert(actual.operationsReview.buckets.length<=18);
 const {operationsReview,...published}=actual;historical(published,expected,label);
}
function checkpoint(actual,expected){
 assert.equal(actual.demandStatus.storage,'native');assert.equal(actual.storedProfiles,0);
 assert.equal(actual.nativeSerial,0);assert.equal(actual.nativeEditRevision,0);assert.equal(actual.nativeCommandSerial,0);
 assert.equal(actual.fleetMinute,Math.floor(actual.minute));assert.equal(expected.fleetMinute,Math.floor(expected.minute));
 assert.deepEqual(actual.urbanDefs,[]);assert.equal(actual.forecastView.covered,0);assert.equal(typeof actual.forecastStatus.dirty,'boolean');
 assert.deepEqual(actual.personalRecords,Q.mergeRecords(actual.personalRecords,{}));
 const {forecastView,personalRecords,nativeSerial,storedProfiles,forecastStatus,nativeEditRevision,nativeCommandSerial,urbanDefs,fleetMinute,...legacy}=structuredClone(actual);
 const {fleetMinute:oldFleetMinute,...oldCheckpoint}=expected;legacy.demandStatus.storage='lazy';historical(legacy,oldCheckpoint,'frozen passenger checkpoint');
}
(async()=>{
 const s=M.init(N.emptyWorld('gba'));Q.enableSatisfaction(s);s.ridership.current.extra={label:'附加字段 😀',missing:undefined};
 const old=structuredClone(s),f={flows:[]},rt=P.create(s,f,420,false),expected=OldP.create(old,f,420,false);P.nativeViews(rt);OldP.nativeViews(expected);
 try{
  // Keep oracle observations off exact day boundaries: its repeated additions
  // drift below midnight after 25 days while the native clock closes the day.
  for(let i=0;i<95;i++){
   await M.advanceBudgetAsync(s,rt,500.01,options);await OldM.advanceBudgetAsync(old,expected,500.01,options);
   world(s,old,`complete world ${i}`);
   const native=await P.historyAsync(rt,false);assert.deepEqual(native,{current:s.ridership.current,history:s.ridership.history},`native authority ${i}`);
   const saved=await P.snapshotAsync(rt);checkpoint(saved,await OldP.snapshotAsync(expected));assert.doesNotThrow(()=>LS.parse(JSON.stringify(LS.pack(s,saved))));world(s,old,`saved world ${i}`);
  }
  assert.equal(s.ridership.history.length,30);
  assert.deepEqual(s.ridership.history.at(-1),old.ridership.history.at(-1));
  console.log('MAP57 lifecycle: 95 complete worlds, native current/history snapshots and runtime saves across 32 days; 30-day retention, empty observations, unknown fields and Unicode preserved.');
 }finally{P.dispose(rt);OldP.dispose(expected);}
})().catch(e=>{console.error(e);process.exitCode=1;});
