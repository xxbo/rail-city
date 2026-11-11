/* Compare versioned public shapes without hiding passenger or accounting differences.
 * Current checkpoints retain independent schema and conservation checks. */
const assert=require('node:assert/strict'),Q=require('../../rail/ridership'),RV=require('../../rail/operations-review'),LS=require('../../rail/local-save');
const clone=structuredClone,EPS=1e-7;
function equal(a,b,label='business',path=''){
 if(typeof a==='number'&&typeof b==='number'&&(!Number.isInteger(a)||!Number.isInteger(b))){assert(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<EPS,`${label}${path}: ${a} != ${b}`);return;}
 if(a&&b&&typeof a==='object'&&typeof b==='object'){
  assert.equal(Array.isArray(a),Array.isArray(b),label+path+' container');assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),label+path+' fields');
  for(const key of Object.keys(b))equal(a[key],b[key],label,path+'.'+key);return;
 }
 assert.deepEqual(a,b,label+path);
}
function world(actual,expected,label='complete world'){
 const a=clone(actual),b=clone(expected);
 if(a.operationsReview&&!b.operationsReview){assert.equal(RV.valid(actual),true,'native review schema');delete a.operationsReview;}
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
  function rows(input){const out={};for(const [key,count]of Object.entries(input||{})){const mapped=token(key);assert(!Object.hasOwn(out,mapped),'distinct cohorts cannot silently collapse under identity mapping');out[mapped]=count;}return out;}
  for(const field of ['queues','outside'])for(const key of Object.keys(out[field]||{}))out[field][key]=rows(out[field][key]);
  for(const field of ['waitSince','outsideSince'])out[field]=Object.fromEntries(Object.entries(out[field]||{}).map(([key,time])=>{const at=key.lastIndexOf('#');return [key.slice(0,at+1)+token(key.slice(at+1)),time];}));
  for(const train of out.trains)train.passengers=rows(train.passengers);
  for(const transfer of out.transfers){assert(labels.has(transfer.journey),'transfer journey exists');transfer.journey=labels.get(transfer.journey);}
  for(const key of Object.keys(out.blocks))if(out.blocks[key]===0)delete out.blocks[key];
  for(const [id,row]of Object.entries(out.stationLimits)){
   if('area' in row){const geometry=Q.limits(state,+id);for(const field of ['area','length','platforms','spacePerPerson','usableWidth'])assert.equal(geometry[field],row[field],'derived station '+id+'/'+field);}
   out.stationLimits[id]={capacity:row.capacity,outsideCapacity:row.outsideCapacity};
  }
  assert.equal(out.fleetMinute,Math.floor(out.minute));delete out.fleetMinute;
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
module.exports={equal,world,checkpoint,batch,create};
