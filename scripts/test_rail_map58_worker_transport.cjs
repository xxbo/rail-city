/* Browser-script execution order and real structured-clone boundaries, without a DOM mock. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const C=require('../rail/city'),U=require('../rail/urban-growth'),P=require('../rail/passengers'),Compact=require('../rail/forecast-catalog'),Snapshot=require('../rail/diagnostic-snapshot'),OC=require('../rail/operations-center'),Metrics=require('../rail/metrics'),{create}=require('./fixtures/rail-memory-grid.cjs');
const {MessageChannel}=require('node:worker_threads');
function worker(file){const sent=[],context=vm.createContext({performance,console,URL,MessageChannel,WebAssembly,Float64Array,Uint8Array,Uint32Array,TextEncoder,TextDecoder,Blob,Response,DecompressionStream,atob,setTimeout,clearTimeout,location:{href:'https://test.invalid/rail/'+file},fetch:async url=>({ok:true,arrayBuffer:async()=>{const p=new URL(url).pathname.replace(/^\/rail\//,''),b=fs.readFileSync(path.join(__dirname,'../rail',p));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}}),postMessage:(data,transfer=[])=>sent.push(structuredClone(data,{transfer}))});context.self=context;context.importScripts=(...files)=>{for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../rail',file.split('?')[0]),'utf8'),context,{filename:file});};vm.runInContext(fs.readFileSync(path.join(__dirname,'../rail',file),'utf8'),context,{filename:file});return {sent,send:(data,transfer=[])=>context.onmessage({data:structuredClone(data,{transfer})})};}
async function verifyDispatch(world, forecast, rt) {
 const Runtime=require('../rail/runtime-wasm'),Fleet=require('../rail/fleet'),Network=require('../rail/network');
 const line=world.services[0],stations=forecast.catchment.stations;
 const riders=Network.stats(world,forecast,line.id).riders;
 const potential=[...new Set(line.stops)].reduce((sum,id)=>{
  const row=stations[id];
  return sum+(row?(row.people+0.7*(row.jobs||0))*0.15:0);
 },0);
 const baseline=Fleet.recommend(world,line,Math.max(riders,potential));
 const original=structuredClone(line.dispatch);
 try {
  const {plan}=await Runtime.dispatchRecommendation(rt,line.id,stations);
  assert(Runtime.usesWorker(rt));
  assert.deepEqual(plan,baseline);
  assert.deepEqual(line.dispatch,original);
  await assert.rejects(Runtime.dispatchRecommendation(rt,'missing-line',stations),/线路不存在/);
 }finally{Runtime.dispose(rt);}
}
async function verifyTokyoHandoff() {
 const world=require('../rail/management').init(require('../rail/network').tokyo());
 const demand=worker('demand-worker.js'),simulation=worker('simulation-worker.js');
 await demand.send({id:1,state:require('../rail/demand-snapshot').capture(world),handoff:'runtimeOnly'});
 const {result,handoff,error}=demand.sent[0];
 assert.ifError(error);
 assert(handoff);
 const {manifest,pages}=result.compactForecast;
 assert.equal(pages,null);
 assert(manifest.count>100000);
 const view=Compact.hydrate(result,handoff);
 assert.equal(Compact.source(view),undefined);
 const packet=Compact.runtimePacket(view);
 const invoke=async (action,args,transfer=[])=>{
  await simulation.send({id:simulation.sent.length+1,kind:'session',action,args},transfer);
  const message=simulation.sent.at(-1);
  assert.ifError(message.error);
  return message.result;
 };
 const {id}=await invoke('create',{world,forecast:packet,start:420,warm:false},Compact.transfers(packet));
 try {
  const {projection}=await invoke('forecastQuery',{id,query:'status'});
  assert.equal(projection.count,manifest.count);
  assert.equal(projection.bytes,8*(manifest.flowLength+manifest.contractLength));
 }finally{await invoke('close',{id});}
}
(async()=>{const s=create(3);U.init(s);s.urban.cells=Object.fromEntries(s.nodes.map(n=>[Math.floor(n.x/12)+':'+Math.floor(n.y/12),{x:n.x,y:n.y,r:4000,c:2500,i:500}]));U.enableDevelopment(s,C.create('gba'),[]);
const demand=worker('demand-worker.js');await demand.send({id:1,state:require('../rail/demand-snapshot').capture(s)});assert.equal(demand.sent.length,1);assert(!demand.sent[0].error,demand.sent[0].error);const result=demand.sent[0].result;assert(result.compactForecast);assert.equal(result.flows,undefined);const f=Compact.hydrate(result),expected=C.evaluate(s);assert.deepEqual(Array.from(f.flows),expected.flows);assert.deepEqual(Array.from(f.preparedDefinitions),Array.from(P.definitions(s,expected)));
const rt=P.create(s,f,480,false),capture=Snapshot.capture(s,rt),diagnostic=worker('operations-worker.js');await diagnostic.send({id:2,version:1,state:capture.state,runtime:capture.runtime,forecast:Compact.transport(f)});assert(!diagnostic.sent[0].error,diagnostic.sent[0].error);assert.deepEqual(diagnostic.sent[0].rows,OC.analyze(capture.state,f,capture.runtime));assert.deepEqual(diagnostic.sent[0].metrics,Metrics.summary(capture.state,f));await verifyDispatch(s,f,rt);await verifyTokyoHandoff();console.log('MAP58 browser Worker scripts: import order, WASM ABI/math imports, gzip city data, demand compact DTO structured clone/hydration, diagnostic DTO reuse and exact rows/metrics.');})().catch(e=>{console.error(e);process.exitCode=1;});
