/* Regenerate only against the exact clean MAP65 worktree. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function start(base,input){const load=n=>require(path.join(base,'rail',n)),N=load('network'),M=load('management'),U=load('urban-growth'),Q=load('ridership'),C=load('city'),Names=load('place-names');const region=input.region;let s=N.emptyWorld(region),playing=true,speed=6,runtime=null,records={},blocked=!!input.readError,status=input.readError?'本地数据库读取失败，已禁止自动覆盖':'';
 const raw=input.stored?.present?input.stored:region==='tokyo'&&input.legacy6?.present?input.legacy6:region==='tokyo'?input.legacy4:null;
 if(raw?.error){blocked=true;status='本地数据库读取失败，已禁止自动覆盖';}else if(raw?.present){const v=structuredClone(raw.value),a=load('save-wasm').run('checkpoint',{value:v,region});if(a.valid){s=a.kind?v.state:v;if(a.kind!==7)s=N.removePreset(s);else{records=a.records;if(typeof v.playing==='boolean')playing=v.playing;if([1,3,6,12,24].includes(v.speed))speed=v.speed;if(a.useRuntime)runtime=v.runtime;}}else{blocked=true;status='存档版本或运行数据校验失败，已禁止自动覆盖';}}
 N.upgrade(s);M.init(s);const migratedUrban=!s.urban;U.init(s);if(!U.validate(s)){delete s.urban;U.init(s);blocked=true;}if(!M.validate(s)){delete s.economy;M.init(s);blocked=true;}
 const migratedFacilities=U.enableAutomatic(s,C.create(region),Names.places(region));U.enableDevelopment(s,C.create(region),Names.places(region));Q.enableSatisfaction(s);return{state:s,migratedUrban,migratedFacilities,blocked,status,playing,speed,runtime,records};
}
if(require.main===module){const base=process.env.RAIL_P3_BASELINE;assert(base);assert.equal(execFileSync('git',['-C',base,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),'bffdd8fbd22e2553a881533b540f878f6ea8fabc');assert.equal(execFileSync('git',['-C',base,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'');const load=n=>require(path.join(base,'rail',n)),out={baseline:'bffdd8fbd22e2553a881533b540f878f6ea8fabc',hashes:{},cases:[]};
 out.hashes.seed=hash(load('engine').newGame());out.hashes.tokyoSeed=hash(load('tokyo').create(load('engine')));
 for(const region of ['tokyo','gba']){const c=load('city').create(region);out.hashes['geo:'+region]=hash({cells:c.cells,totals:c.totals,cell:c.cell,area:c.area,metadata:c.metadata,byCity:c.byCity});out.hashes['places:'+region]=hash(load('place-names').places(region));out.hashes['hubs:'+region]=hash(load('hubs').forRegion(region));out.hashes['empty:'+region]=hash(load('network').emptyWorld(region));
  const valid=start(base,{region}).state,legacy=load('network').emptyWorld(region),badUrban=structuredClone(valid);badUrban.urban.revision=-1;const badEconomy=structuredClone(valid);badEconomy.economy.cash=-1;
  const envelope=state=>({gameVersion:7,state,runtime:null,speed:12,playing:false,personalRecords:{bestDay:3,totalCompleted:12},runtimeVersion:1});
  const inputs=[{region},{region,stored:{present:true,value:envelope(valid)}},{region,stored:{present:true,value:{gameVersion:6,state:legacy}}},{region,stored:{present:true,value:legacy}},{region,stored:{present:true,value:envelope(badUrban)}},{region,stored:{present:true,value:envelope(badEconomy)}},{region,stored:{present:true,value:{...envelope(valid),runtimeVersion:2}}},{region,stored:{present:true,error:true}},{region,readError:true},{region,legacy6:{present:true,value:{gameVersion:6,state:legacy}}}];
  for(const input of inputs)out.cases.push({input,expected:start(base,input)});
 }
 fs.writeFileSync(path.join(__dirname,'fixtures/rail-p31-map65-oracle.json'),JSON.stringify(out,null,2)+'\n');console.log('Frozen P3-1 complete geometry hashes and 20 complete startup transitions.');
}
module.exports={start,hash};
