/* Historical suites stage explicit native commands and detached cold fixtures.
 * The reference keeps its frozen simulation; production never executes it. */
const assert=require('node:assert/strict'),P=require('../../rail/passengers'),Runtime=require('../../rail/runtime-wasm'),Oracle=require('./native-oracle.cjs'),RV=require('../../rail/operations-review');
const scenes=new Set(),metrics={nativeReroutes:0};
function pair(make,forecast,OldP,start=480,weighted=false,prepare=()=>{}){
 const a=make();a.economy.minute=start;prepare(a);const b=structuredClone(a),f=forecast(a),ra=Oracle.create(P,a,f,start,weighted),rb=OldP.create(b,f,start,false);if(weighted)rb.arrivalMode='weighted';
 const p={a,b,f,forecast:f,ra,rb,OldP};scenes.add(p);return p;
}
function compare(p){Oracle.world(p.a,p.b);Oracle.checkpoint(P.snapshot(p.ra),p.OldP.snapshot(p.rb),p.rb.defs,p.a);}
function advance(p,OldM,minutes){const native=Runtime.advance(p.a,p.ra,minutes,{full:true});metrics.nativeReroutes=Math.max(metrics.nativeReroutes,Runtime.querySync(p.ra,'storage').nativeReroutes);const reference=OldM.advance(p.b,p.rb,minutes);assert.equal(native.running,reference);compare(p);return native;}
function edit(p,OldM,command){
 const result=Runtime.commandSync(p.ra,command).result;assert(!result.error,result.error);
 const mark=p.b.operationsReview?RV.prepare(p.b,p.rb):null;
 const legacy=OldM.change(p.b,state=>require('../../rail/editor-wasm').command(state,command.op,command.args));assert(!legacy.error,legacy.error);
 p.OldP.reconcile(p.rb,p.b);if(mark)RV.record(p.b,p.rb,mark);return result;
}
function demand(p,forecast){const f=forecast(p.a);Runtime.replaceDemandSync(p.ra,f);p.OldP.rebase(p.rb,p.b,forecast(p.b));p.f=f;p.forecast=f;}
function fixture(p,change){
 const a=P.snapshot(p.ra),b=structuredClone(p.OldP.snapshot(p.rb));b.urbanDefs=structuredClone(p.rb.defs);P.dispose(p.ra);p.OldP.dispose?.(p.rb);change(p.a,a,0);change(p.b,b,1);
 p.ra=P.restore(p.a,p.f,a);p.rb=p.OldP.restore(p.b,p.f,b);assert(p.ra&&p.rb,'detached fixture restores');p.rb.demandStatus.updatedAt=b.demandStatus.updatedAt;
}
function close(p){P.dispose(p.ra);p.OldP.dispose?.(p.rb);scenes.delete(p);}
function closeAll(){for(const p of [...scenes])close(p);}
// MAP43/44 froze passengers before the first management fixture was captured.
// Bind the unchanged frozen JS finance driver to those exact older passengers.
function legacyManagement(passengers,ridership){
 const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),vm=require('node:vm');
 const filename=path.resolve(__dirname,'../fixtures/rail-map45-management.cjs'),local=createRequire(filename),module={exports:{}};
 const scoped=name=>name==='./rail-map45-passengers.cjs'?passengers:name==='./rail-map45-ridership.cjs'?ridership:local(name);
 vm.compileFunction(fs.readFileSync(filename,'utf8'),['require','module','exports'],{filename})(scoped,module,module.exports);return module.exports;
}
module.exports={pair,compare,advance,edit,demand,fixture,close,closeAll,legacyManagement,metrics};
