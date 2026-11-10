/* Current release closure and per-function dispositions. Run explicitly during
   P3-9 validation; never rewrite the historical P3-0 inventory implicitly. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const audit=require('./audit_rail_p3.cjs'),manifest=require('./rail-public-assets.json');
const root=path.resolve(__dirname,'..'),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function inspect(){
 const inventory=await audit.inventory(),policy=JSON.parse(fs.readFileSync(path.join(root,'scripts/rail-p3-boundary-policy.json'),'utf8'));
 const published=new Set(manifest.files.map(p=>'rail/'+p)),closure=new Set(Object.values(inventory.closures).flat());
 const todo=manifest.files.filter(p=>p.endsWith('-worker.js')).map(p=>'rail/'+p);
 while(todo.length){const file=todo.pop();if(closure.has(file))continue;closure.add(file);for(const ref of inventory.files[file]?.dependencies||[])if(ref.kind==='importScripts')todo.push(ref.target);}
 const violations=[],pending=[],functions=[];
 for(const file of closure){if(!published.has(file))violations.push('Unpublished runtime dependency '+file);}
 for(const file of manifest.files){
  if(!fs.existsSync(path.join(root,'rail',file)))violations.push('Missing published asset '+file);
  if(file.endsWith('.wasm')&&file!==manifest.core)violations.push('Historical WASM in publication '+file);
 }
 for(const [file,row]of Object.entries(inventory.files)){
  if(!closure.has(file))continue;
  const rule=policy.files[file];
  if(!rule?.owner||!rule.phase)violations.push('Unreviewed module '+file);
  for(const fn of row.functions){
   const disposition=fn.role==='ui'?'界面保留':fn.role==='data'?'数据保留':fn.role==='platform'?'平台绑定':'待逐函数复核';
   functions.push({file,id:fn.id,sha256:fn.sha256,role:fn.role,owner:fn.owner,disposition});
   if(disposition==='待逐函数复核')pending.push(file+':'+fn.id);
  }
 }
 const routing=fs.readFileSync(path.join(root,'rail/routing-wasm.js'),'utf8');
 if(/rail_host\s*:\s*\{/.test(routing))violations.push('Handwritten host JSON reintroduced');
 const worker=fs.readFileSync(path.join(root,'rail/worker-client.js'),'utf8');
 if(/options\.fallback\s*\(/.test(worker))violations.push('JS fallback policy reintroduced');
 const report={schemaVersion:1,scope:'current source closure; source inspection is not runtime acceptance',core:manifest.core,violations,pending,functions,assets:manifest.files.filter(p=>fs.existsSync(path.join(root,'rail',p))).map(file=>({file,sha256:hash(path.join(root,'rail',file))})),complete:violations.length===0&&pending.length===0};
 return report;
}
if(require.main===module)inspect().then(report=>{const target=process.argv.find(a=>a.startsWith('--output='));if(target)fs.writeFileSync(path.resolve(target.slice(9)),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({complete:report.complete,violations:report.violations,pendingFunctions:report.pending.length,functions:report.functions.length,assets:report.assets.length}));if(!report.complete)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={inspect};
