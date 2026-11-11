/* Cold metadata stays inside Rust; only fixed-size advance requests cross the host boundary. */
const assert=require('node:assert/strict');
const P=require('../rail/passengers'),M=require('../rail/management'),B=require('../rail/bootstrap-wasm'),Runtime=require('../rail/runtime-wasm'),Catalog=require('../rail/forecast-catalog');
const {create}=require('./fixtures/rail-memory-grid.cjs');
const s=create(2),line=s.services[0];let reads=0;
const catalog=Array.from({length:2600},(_,id)=>({id,legs:[{service:line.id,dir:1,from:line.stops[0],to:line.stops.at(-1)}],
 get daily(){reads++;return 20;},fare:180+id,purpose:'work',back:false,hub:null,externalKind:null,
 from:line.stops[0],to:line.stops.at(-1),lineIds:[line.id],byLine:{[line.id]:1}}));
const forecast={preparedDefinitions:catalog};const initial=P.create(s,forecast,480,false);
const saved=P.snapshot(initial);saved.arrivalMode='weighted';P.dispose(initial);
const rt=P.restore(s,forecast,saved);assert(rt);assert.equal(rt.arrivalMode,'weighted');assert.equal(reads,catalog.length,'one DTO ingestion, independent of runtime restore');
const native=B.runtime,nativeForecast=B.forecast,requests=[];let forecastRequests=0;
try{
 M.advance(s,rt,.1);const cold=Runtime.querySync(rt,'storage');assert.equal(cold.cachedProfiles,0);assert.equal(cold.metadataBatches,0);
 const dailyReads=Catalog.status(forecast).dailyReads;reads=0;
 B.runtime=(action,args)=>{const result=native(action,args);requests.push({action,bytes:JSON.stringify(args).length,batch:result.batch});return result;};
 B.forecast=(...args)=>{forecastRequests++;return nativeForecast(...args);};
 try{M.advance(s,rt,.9);}finally{B.runtime=native;B.forecast=nativeForecast;}
 const storage=Runtime.querySync(rt,'storage');
 assert.equal(storage.cachedProfiles,catalog.length);assert.equal(storage.metadataBatches,2,'2600 cold profiles use two bounded native metadata batches');
 assert.equal(storage.preparedDefinitions,0,'all staged templates are committed or released');assert.equal(storage.storedDefinitions,catalog.length);
 assert.equal(reads,0,'unchanged weights never revisit JS getters');assert.equal(Catalog.status(forecast).dailyReads,dailyReads,'unchanged native weights never rescan the directory');
 assert.equal(forecastRequests,0,'native continuations never ask JS for metadata');assert.equal(requests.length,1);assert.equal(requests[0].action,'advanceAll');assert(requests[0].bytes<150);
 assert(requests[0].batch.events.every(event=>event.kind==='TrainCreated'),'arrival transactions stay inside Rust');
 assert(rt.generated>0);const summary=P.summary(rt);assert(Math.abs(summary.generated-summary.waiting-summary.onboard-summary.completed-summary.cancelled)<1e-6);
 console.log(JSON.stringify({test:'MAP52 transport',nativeMetadataBatches:storage.metadataBatches,cachedProfiles:storage.cachedProfiles,hostRequests:requests.length,requestBytes:requests[0].bytes,jsDailyReads:reads}));
}finally{B.runtime=native;B.forecast=nativeForecast;P.dispose(rt);}
