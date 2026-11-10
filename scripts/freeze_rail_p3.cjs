/* Explicit regeneration from a clean, exact MAP65 checkout; never run by CI. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const PIN='bffdd8fbd22e2553a881533b540f878f6ea8fabc',out=path.join(__dirname,'fixtures');
function fixture(base,region,modern=true){
 const load=n=>require(path.join(base,'rail',n)),N=load('network'),M=load('management'),F=load('fleet'),D=load('demand-model'),s=M.init(N.emptyWorld(region));
 if(modern)N.upgrade(s);else s.routeModel=1;
 assert(!N.addLine(s,[{x:600,y:500,nameSeed:.125},{x:640,y:500,nameSeed:.25},{x:680,y:500,nameSeed:.5}],modern?{stockSpec:'6B'}:null).error);
 if(modern){F.purchase(s,'6B',8);N.configure(s,s.services[0].id,{dispatch:{mode:'manual',manual:8,offPeak:8,peak:8}});}
 const fields=['people','jobs','shops','industry','leisure'],cells=s.nodes.map((n,i)=>({id:'c'+i,x:n.x,y:n.y,w:8,h:8,area:.13,people:3000+i*200,jobs:1500+i*100,shops:500,industry:50,leisure:200}));
 const m=D.evaluate(s,{cells,totals:Object.fromEntries(fields.map(k=>[k,cells.reduce((v,c)=>v+c[k],0)])),metadata:{effectiveConnections:true,demandZoneUnits:40}},{compact:true});return{s,m};
}
function runtimeTrace(base){const load=n=>require(path.join(base,'rail',n)),P=load('passengers'),M=load('management'),result=[];
 for(const region of ['tokyo','gba'])for(const modern of [true,false]){
  const {s,m}=fixture(base,region,modern),rt=P.create(s,m,479.9,false),windows=[];
  for(const dt of [.1,.1,1,5]){M.advance(s,rt,dt);windows.push({dt,state:structuredClone(s),runtime:structuredClone(P.snapshot(rt))});}
  result.push({region,modern,windows});
 }return result;
}
if(require.main===module){
 const base=process.env.RAIL_P3_BASELINE;if(!base)throw Error('Set RAIL_P3_BASELINE to the exact clean MAP65 worktree');
 const git=args=>spawnSync('git',['-C',base,...args],{encoding:'utf8'}).stdout.trim();assert.equal(git(['rev-parse','HEAD']),PIN);assert.equal(git(['status','--porcelain','--untracked-files=no']),'');
 const load=n=>require(path.join(base,'rail',n)),Core=load('routing-wasm'),Wire=load('value-wire'),original=Core.kernel;let config;
 Core.kernel=(name,values,...args)=>{if(name==='editor_config')config=Wire.decode(values).value;return original(name,values,...args);};
 const worlds=['tokyo','gba'].map(region=>load('management').init(load('network').upgrade(load('network').emptyWorld(region))));
 assert(config);Core.kernel=original;
 const input={protocolVersion:1,op:'open',world:worlds[1],config},data=Wire.encode(input),bytes=Buffer.alloc(data.length*8);data.forEach((n,i)=>bytes.writeDoubleLE(n,i*8));
 fs.writeFileSync(path.join(out,'rail-p3-map65-session.wire'),bytes);
 const cold=[];for(const initial of worlds){const command={kind:'fleet',op:'purchase',args:{spec:'6B',count:2}},r=load('assets-wasm').transaction(initial,command,true);assert(!r.error);cold.push({initial,command,after:r.after,quote:Object.fromEntries(Object.entries(r).filter(([k])=>!['after','result'].includes(k))),result:r.result});}
 const oracle={baseline:PIN,wireSha256:crypto.createHash('sha256').update(bytes).digest('hex'),config,worlds,cold,runtime:runtimeTrace(base)};
 fs.writeFileSync(path.join(out,'rail-p3-map65-oracle.json'),JSON.stringify(oracle,null,2)+'\n');
 console.log('Frozen MAP65: two cold asset worlds, four complete modern/weighted runtime traces, ordered JSON and native wire.');
}
module.exports={fixture,runtimeTrace};
