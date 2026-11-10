/* Cold API + module/WASM initialization, separate processes and exact complete results. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync,execFileSync}=require('node:child_process'),{hash,start}=require('./freeze_rail_p31.cjs');
const modes=['javascript','previous','current'],scopes=['seed','tokyoGeo','gbaGeo','tokyoStartup','gbaStartup'];
if(process.argv[2]==='child'){
 const mode=process.argv[3],scope=process.argv[4],base=process.argv[5],load=n=>require(path.join(base,'rail',n));
 const cpu=process.cpuUsage(),at=performance.now();let value;
 if(scope==='seed')value=load('engine').newGame();
 else if(scope.endsWith('Geo')){const c=load('city').create(scope==='gbaGeo'?'gba':'tokyo');value={cells:c.cells,totals:c.totals,cell:c.cell,area:c.area,metadata:c.metadata,byCity:c.byCity};}
 else value=mode==='current'?load('bootstrap-wasm').start({region:scope==='gbaStartup'?'gba':'tokyo'}).state:start(base,{region:scope==='gbaStartup'?'gba':'tokyo'}).state;
 const ms=performance.now()-at,used=process.cpuUsage(cpu);global.gc?.();const heapMiB=process.memoryUsage().heapUsed/1048576,peakRssMiB=process.resourceUsage().maxRSS/1024;
 const main=mode==='javascript'?0:load('routing-wasm').status().memoryBytes/1048576,bootstrap=mode==='current'?load('bootstrap-wasm').memoryBytes()/1048576:0;
 console.log(JSON.stringify({mode,scope,ms,cpuMs:(used.user+used.system)/1000,heapMiB,peakRssMiB,mainWasmMiB:main,bootstrapWasmMiB:bootstrap,hash:hash(value)}));
}else{
 const roots={javascript:process.env.RAIL_JS_BASELINE,previous:process.env.RAIL_PREVIOUS_ROOT,current:path.resolve(__dirname,'..')};assert(roots.javascript&&roots.previous);
 assert.equal(execFileSync('git',['-C',roots.javascript,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),'498c5cd2af607e60dd1c75a8ba5863c08ac5d4fa');assert.equal(execFileSync('git',['-C',roots.previous,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),'e2f5414c3d78ce2ee4ffdfa1b92aab929aa895f6');
 const results=[];for(let round=0;round<3;round++)for(const scope of scopes)for(const mode of round%2?[...modes].reverse():modes){const r=spawnSync(process.execPath,['--expose-gc',__filename,'child',mode,scope,roots[mode]],{encoding:'utf8',timeout:120000});if(r.status)throw Error(r.stderr||r.stdout);results.push({...JSON.parse(r.stdout),round});}
 const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];const summary=scopes.map(scope=>{const rows=results.filter(r=>r.scope===scope),hashes=Object.fromEntries(modes.map(mode=>[mode,rows.find(r=>r.mode===mode).hash]));assert.equal(hashes.current,hashes.previous,'P3-0 full ordered result changed: '+scope);return{scope,comparableToJavaScript:hashes.javascript===hashes.current,hashes,modes:modes.map(mode=>{const r=rows.filter(r=>r.mode===mode);return{mode,ms:median(r.map(x=>x.ms)),cpuMs:median(r.map(x=>x.cpuMs)),heapMiB:median(r.map(x=>x.heapMiB)),peakRssMiB:Math.max(...r.map(x=>x.peakRssMiB)),mainWasmMiB:r[0].mainWasmMiB,bootstrapWasmMiB:r[0].bootstrapWasmMiB};})};});
 console.log(JSON.stringify({scope:'Cold API includes JS module loading, WASM compilation/instance and full compatibility view. Three fresh processes per mode/scope, reverse order in round 2. Hash/GC outside time. Peak RSS captured before hash allocation. No DOM, network or FPS.',baseline:'498c5cd2af607e60dd1c75a8ba5863c08ac5d4fa',previous:'e2f5414c3d78ce2ee4ffdfa1b92aab929aa895f6',summary,results},null,2));
}
