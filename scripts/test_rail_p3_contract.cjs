/* Exercise real opt-in Rust WASM against complete frozen MAP65 states. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {create}=require('./fixtures/rail-session-bridge.cjs'),Wire=require('../rail/value-wire'),oracle=require('./fixtures/rail-p3-map65-oracle.json');
const exact=(a,b)=>{assert.deepEqual(a,b);assert.equal(JSON.stringify(a),JSON.stringify(b));};
let checks=0;function check(value){assert(value);checks++;}
check(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'fixtures/rail-p3-map65-session.wire'))).digest('hex')===oracle.wireSha256);
for(const c of oracle.cold){
 const bridge=create(),send=x=>bridge.request({protocolVersion:1,...x});
 const open=send({op:'open',world:c.initial,config:oracle.config});check(open.ok);check(open.sessionId===1&&open.revision===0);
 const request=x=>send({sessionId:1,...x}),query=()=>request({op:'query',view:'snapshot'}).result;
 exact(query(),c.initial);
 const preview=request({op:'preview',expectedRevision:0,command:c.command});check(preview.ok);exact(query(),c.initial);exact(preview.result.quote,c.quote);
 const cmd={op:'dispatch',commandId:1,expectedRevision:0,command:c.command},done=request(cmd);check(done.ok&&done.revision===1);exact(query(),c.after);exact(done.result.value,c.result);exact(done.result.quote,c.quote);
 // A lost response can be resolved without executing the purchase again.
 const replay=request(cmd);check(replay.ok&&replay.replayed&&replay.revision===1);exact(query(),c.after);
 const receipt=request({op:'query',view:'receipt',commandId:1});check(receipt.ok&&receipt.replayed);exact(receipt.result,done.result);
 const reused=request({...cmd,command:{...c.command,args:{spec:'6B',count:3}}});check(reused.error.code==='COMMAND_ID_REUSED');exact(query(),c.after);
 const conflict=request({...cmd,commandId:2});check(conflict.error.code==='REVISION_CONFLICT');exact(query(),c.after);
 const fail=request({...cmd,commandId:3,expectedRevision:1,command:{kind:'fleet',op:'purchase',args:{spec:'invalid',count:2}}});check(fail.error.code==='COMMAND_REJECTED');exact(query(),c.after);
 const badId=request({...cmd,commandId:NaN});check(badId.error.code==='INVALID_COMMAND_ID');
 const huge=request({...cmd,commandId:4,extra:'x'.repeat(5000)});check(huge.error.code==='COMMAND_TOO_LARGE');exact(query(),c.after);
 const unsupported=request({...cmd,commandId:4,expectedRevision:1,command:{kind:'runtime',op:'advance',args:{minutes:1}}});check(unsupported.error.code==='COMMAND_NOT_SUPPORTED_YET');exact(query(),c.after);
 const view=query();view.depot.stock['6B']=999;exact(query(),c.after);
 check(request({op:'query',view:'unknown'}).error.code==='UNKNOWN_VIEW');
 // Failed replacement preserves the existing session.
 check(!send({op:'open',world:{},config:oracle.config}).ok);exact(query(),c.after);
 check(send({op:'open',world:c.initial,config:oracle.config,runtime:{minute:420}}).error.code==='RUNTIME_NOT_SUPPORTED_YET');exact(query(),c.after);
 for(const wire of [[],[NaN],[0,7,1],[0,4],[0,6,1e9],[0,1,0]]){const result=Wire.decode(bridge.wire(wire)).value;check(result.error.code==='INVALID_WIRE');exact(query(),c.after);}
 // Even an evicted ID is never executed a second time. Rejected receipts are bounded too.
 for(let id=5;id<140;id++)check(request({...cmd,commandId:id,expectedRevision:1,command:{kind:'invalid'}}).error.code==='COMMAND_NOT_SUPPORTED_YET');
 check(request(cmd).error.code==='COMMAND_EXPIRED');exact(query(),c.after);
 const high=request({op:'query',view:'status'});check(high.result.highWater===139&&high.result.receiptLimit===128);
 check(send({op:'open',world:c.initial,config:oracle.config}).sessionId===2);
 check(request({op:'query',view:'snapshot'}).error.code==='SESSION_MISMATCH');
 check(send({op:'close',sessionId:2}).ok);check(send({op:'query',sessionId:2,view:'snapshot'}).error.code==='NO_SESSION');
}
// Baseline runtime remains unchanged; future ownership migration must preserve these full states.
const {runtimeTrace}=require('./freeze_rail_p3.cjs'),P=require('../rail/passengers'),LS=require('../rail/local-save'),Q=require('../rail/ridership');
function business(actual,expected,field=''){
 if(typeof actual==='number'&&typeof expected==='number'&&(!Number.isInteger(actual)||!Number.isInteger(expected))){assert(Number.isFinite(actual)&&Number.isFinite(expected)&&Math.abs(actual-expected)<1e-7,field+': '+actual+' != '+expected);return;}
 if(actual&&expected&&typeof actual==='object'&&typeof expected==='object'){assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort(),field+' keys');for(const key of Object.keys(expected))business(actual[key],expected[key],field+'.'+key);return;}
 assert.deepEqual(actual,expected,field);
}
const traces=runtimeTrace(path.resolve(__dirname,'..'));assert.equal(traces.length,oracle.runtime.length);
for(let i=0;i<traces.length;i++){
 const trace=traces[i],before=oracle.runtime[i];assert.equal(trace.region,before.region);assert.equal(trace.modern,before.modern);assert.equal(trace.windows.length,before.windows.length);
 for(let j=0;j<trace.windows.length;j++){
  const current=trace.windows[j],old=before.windows[j],saved=current.runtime;assert.equal(current.dt,old.dt);
  // Validate the complete new native contract independently, including ordered
  // restore. Only the historical comparison below uses the old public shape.
  assert.equal(saved.demandStatus.storage,'native');assert.equal(saved.storedProfiles,saved.urbanDefs.length);assert.equal(saved.storedProfiles,saved.demandStatus.profiles);
  assert.equal(saved.nativeSerial,saved.nextId-1);assert.equal(saved.nativeEditRevision,0);assert.equal(saved.nativeCommandSerial,0);
  exact(saved.forecastStatus,{dirty:false,busy:false,stamp:[0,0,0,0]});exact(saved.forecastView,{population:9600,covered:9600});exact(LS.records(saved.personalRecords),saved.personalRecords);
  assert.doesNotThrow(()=>LS.parse(JSON.stringify(LS.pack(current.state,saved))));
  const forecast={preparedDefinitions:saved.urbanDefs,population:saved.forecastView.population,catchment:{covered:saved.forecastView.covered},flows:[]},world=structuredClone(current.state),restored=P.restore(world,forecast,structuredClone(saved));assert(restored,'complete current checkpoint restores');try{exact(P.snapshot(restored),saved);exact(world,current.state);}finally{P.dispose(restored);}
  const state=structuredClone(current.state),oldState=structuredClone(old.state),runtime=structuredClone(saved),expected=structuredClone(old.runtime);
  if(trace.modern){assert.equal(state.operationsReview.version,1);delete state.operationsReview;}else{assert.deepEqual(state.ridership.lines,{});for(const row of Object.values(oldState.ridership.lines)){for(const key of ['awareness','trust'])assert(Number.isFinite(row[key])&&row[key]>=0&&row[key]<=1);assert(Number.isFinite(row.serviceDays)&&row.serviceDays>=0);}oldState.ridership.lines={};}
  for(const key of ['forecastView','personalRecords','nativeSerial','storedProfiles','forecastStatus','nativeEditRevision','nativeCommandSerial','urbanDefs'])delete runtime[key];
  runtime.demandStatus.storage='lazy';
  for(const value of [runtime,expected])for(const key of Object.keys(value.blocks))if(value.blocks[key]===0)delete value.blocks[key];
  for(const [id,row]of Object.entries(expected.stationLimits)){
   const limits=Q.limits(current.state,+id);for(const key of ['area','length','platforms','spacePerPerson','usableWidth'])assert.equal(limits[key],row[key],'derived station geometry '+key);
  }
  for(const value of [runtime,expected])for(const [id,row]of Object.entries(value.stationLimits))value.stationLimits[id]={capacity:row.capacity,outsideCapacity:row.outsideCapacity};
  business(state,oldState,'world');business(runtime,expected,'passengers');checks++;
 }
}
console.log(`P3-0 contract: ${checks} guards plus complete ordered cold-world and four MAP65 business traces plus exact ordered native restores passed; real Rust WASM, no JS business fallback.`);
