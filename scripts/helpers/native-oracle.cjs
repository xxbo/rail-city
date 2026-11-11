/* Compare versioned public shapes without hiding passenger or accounting differences.
 * Current checkpoints retain independent schema and conservation checks. */
const assert=require('node:assert/strict'),Q=require('../../rail/ridership'),RV=require('../../rail/operations-review'),LS=require('../../rail/local-save');
const clone=structuredClone,EPS=1e-7;
function equal(a,b,label='business',path=''){
 if(a===b)return; // Equal sentinels include infinite headways; signed zero has one JSON amount.
 if(typeof a==='number'&&typeof b==='number'&&(!Number.isInteger(a)||!Number.isInteger(b))){assert(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(EPS,64*Number.EPSILON*Math.max(Math.abs(a),Math.abs(b))),`${label}${path}: ${a} != ${b}`);return;}
 if(a&&b&&typeof a==='object'&&typeof b==='object'){
  assert.equal(Array.isArray(a),Array.isArray(b),label+path+' container');assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),label+path+' fields');
  for(const key of Object.keys(b))equal(a[key],b[key],label,path+'.'+key);return;
 }
 assert.deepEqual(a,b,label+path);
}
function world(actual,expected,label='complete world'){
 const a=clone(actual),b=clone(expected);
 if(a.operationsReview&&!b.operationsReview){assert.equal(RV.valid(actual),true,'native review schema');delete a.operationsReview;}
 for(const [id,line]of Object.entries(a.ridership?.lines||{}))if(line.observations&&!b.ridership?.lines?.[id]?.observations){
  const o=line.observations;assert.deepEqual(Object.keys(o).sort(),['covered','load','loss','speed','total','wait']);
  for(const value of Object.values(o))assert(Number.isFinite(value)&&value>=0,'finite nonnegative observation');
  assert(o.loss<=1&&o.covered<=o.total+EPS,'observation bounds');
  const clamp=x=>Math.max(0,Math.min(1,x));equal(line.scores.waiting,clamp(1-Math.max(0,o.wait-2)/18),'observation waiting score');
  equal(line.scores.crowding,clamp(1-Math.max(0,o.load-.55)/.6-o.loss*.65),'observation crowding score');
  equal(line.scores.coverage,o.total?clamp(o.covered/o.total):.6,'observation coverage score');delete line.observations;
 }
 equal(a,b,label);
}
function identity(j){return JSON.stringify([j.legs,j.from,j.to,j.purpose,j.back,j.hub??null,j.externalKind??null,j.fare,j.lineIds,Object.entries(j.byLine||{}).sort(([a],[b])=>a.localeCompare(b))]);}
function checkpoint(actual,expected,legacyDefs,state,label='complete checkpoint'){
 assert(Array.isArray(actual.urbanDefs));assert(Array.isArray(legacyDefs));
 assert.equal(actual.demandStatus.storage,'native');assert.equal(actual.storedProfiles,actual.urbanDefs.length);
 for(const key of ['nativeSerial','nativeEditRevision','nativeCommandSerial'])assert(Number.isSafeInteger(actual[key])&&actual[key]>=0,'native '+key);
 assert.equal(actual.nativeSerial,actual.nextId-1);assert.equal(typeof actual.forecastStatus.dirty,'boolean');assert.equal(typeof actual.forecastStatus.busy,'boolean');
 assert.deepEqual(LS.records(actual.personalRecords),actual.personalRecords,'canonical native records');
 assert(Number.isFinite(actual.forecastView.covered)&&actual.forecastView.covered>=0);
 const keys=[...new Set([...actual.urbanDefs,...legacyDefs].map(identity))].sort(),index=new Map(keys.map((key,i)=>[key,i]));
 function canonical(value,defs){
  const out=clone(value),labels=new Map(defs.map(j=>[j.id,index.get(identity(j))]));
  function token(key){const [id,leg,...stamp]=key.split(':');assert(labels.has(+id),'referenced journey '+id);return [labels.get(+id),leg,...stamp].join(':');}
  function rows(input,since,prefix){
   const out={};for(const [key,count]of Object.entries(input||{})){
    const age=since?.[prefix+'#'+key],mapped=token(key)+(Number.isFinite(age)?'@'+Math.round(age*1e6):'');
    out[mapped]=(out[mapped]||0)+count;
   }
   equal(Object.values(out).reduce((n,c)=>n+c,0),Object.values(input||{}).reduce((n,c)=>n+c,0),'canonical cohort conservation');return out;
  }
  for(const [field,ages]of [['queues','waitSince'],['outside','outsideSince']]){
   const oldAges=out[ages]||{},newAges={};
   for(const key of Object.keys(out[field]||{})){
    const input=out[field][key];out[field][key]=rows(input,oldAges,key);
    for(const tokenKey of Object.keys(input)){const age=oldAges[key+'#'+tokenKey];if(Number.isFinite(age))newAges[key+'#'+token(tokenKey)+'@'+Math.round(age*1e6)]=age;}
   }
   out[ages]=newAges;
  }
  for(const train of out.trains)train.passengers=rows(train.passengers);
  const transfers=new Map();for(const transfer of out.transfers){
   assert(labels.has(transfer.journey),'transfer journey exists');const journey=labels.get(transfer.journey),key=[journey,transfer.leg,Math.round(transfer.ready*1e6),transfer.station].join('|');
   const prior=transfers.get(key);if(prior)prior.amount+=transfer.amount;else transfers.set(key,{...transfer,journey});
  }
  equal([...transfers.values()].reduce((n,t)=>n+t.amount,0),out.transfers.reduce((n,t)=>n+t.amount,0),'transfer cohort conservation');
  out.transfers=[...transfers.values()].sort((a,b)=>Math.round(a.ready*1e6)-Math.round(b.ready*1e6)||a.station-b.station||a.journey-b.journey||a.leg-b.leg);
  // Legacy snapshots accidentally include an ephemeral Map containing both
  // candidate paths and journeys; JSON files omit those entries entirely.
  assert(out._routes==null||out._routes instanceof Map,'route cache has its legacy transient type');delete out._routes;
  const activeRuns=new Set(require('../../rail/service-plan').expand(state).services.map(l=>l.id));
  for(const [key,schedule]of Object.entries(out.departures||{}))if(!activeRuns.has(key.slice(0,key.lastIndexOf('|')))){
   assert(typeof schedule.next==='number'&&typeof schedule.headway==='number'&&!Number.isNaN(schedule.next)&&!Number.isNaN(schedule.headway),'retired schedule remains numeric');delete out.departures[key];
  }
  for(const key of Object.keys(out.blocks))if(out.blocks[key]===0)delete out.blocks[key];
  for(const [id,row]of Object.entries(out.stationLimits)){
   if('area' in row){const geometry=Q.limits(state,+id);for(const field of ['area','length','platforms','spacePerPerson','usableWidth'])assert.equal(geometry[field],row[field],'derived station '+id+'/'+field);}
   out.stationLimits[id]={capacity:row.capacity,outsideCapacity:row.outsideCapacity};
  }
  assert((out.fleetMinute===undefined&&out.trains.length===0)||(Number.isInteger(out.fleetMinute)&&(out.fleetMinute===-1||out.fleetMinute===Math.floor(out.minute))),'fleet cache minute, cold empty cache or invalidation sentinel');delete out.fleetMinute;
  for(const field of ['urbanDefs','forecastView','personalRecords','nativeSerial','storedProfiles','forecastStatus','nativeEditRevision','nativeCommandSerial'])delete out[field];
  out.demandStatus.storage='lazy';return out;
 }
 equal(canonical(actual,actual.urbanDefs),canonical(expected,legacyDefs),label);
}
function batch(actual,expected,label='advance batch'){
 assert.equal(typeof actual.boundary,'boolean');assert(Array.isArray(actual.events));const ids=new Set();
 for(const event of actual.events){assert.equal(event.kind,'TrainCreated');for(const key of ['uid','ordinal'])assert(Number.isSafeInteger(event[key])&&event[key]>0);assert(!ids.has(event.uid),'one creation per UID');ids.add(event.uid);}
 const {boundary,events,...business}=actual;equal(business,expected,label);
}
function create(P,state,forecast,start,weighted=false){return P.create(state,forecast,start,false,{arrivalMode:weighted?'weighted':'integer'});}
// Before MAP50 the frozen game exposes a boolean full-quantum advance only.
// Drive that API at the same 0.1 minute UI boundaries; retain its own simulation.
function advanceLegacy(M,state,rt,minutes,options={}){
 if(M.advanceBudget)return M.advanceBudget(state,rt,minutes,options);
 const now=options.now||(()=>performance.now()),start=now(),max=options.maxSteps??100,budget=options.budget??6;
 let remaining=minutes,steps=0,running=true,reason='complete';
 while(remaining>1e-8){
  if(options.shouldYield?.()){reason='interrupted';break;}
  const dt=Math.min(.1,remaining);running=M.advance(state,rt,dt);remaining-=dt;
  if(!running){reason='blocked';break;}steps++;
  if(remaining<=1e-8)break;if(steps>=max){reason='steps';break;}if(now()-start>=budget){reason='time';break;}
 }
 return {running,remaining,steps,consumed:minutes-remaining,reason};
}
module.exports={equal,world,checkpoint,batch,create,advanceLegacy};
