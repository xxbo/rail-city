/* Explicit P3-9 evidence runner. Preparing this source does not run acceptance.
   A subset, missing scenario evidence or absent performance data stays incomplete. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const plan=require('./rail-migration-acceptance.json'),root=path.resolve(__dirname,'..');
const args=process.argv.slice(2),flag=name=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
if(args.includes('--list')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
const output=path.resolve(flag('--output')||'rail-migration-evidence.json'),only=flag('--only');
const source=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
if(source.status!==0)throw Error('Cannot identify source revision');
const sha=source.stdout.trim(),results=[];
for(const task of plan.tasks){
 if(only&&only!==task.id){results.push({id:task.id,status:'not-run'});continue;}
 const start=Date.now(),[command,...argv]=task.command;
 const run=spawnSync(command,argv,{cwd:root,stdio:'inherit',env:{...process.env,RAIL_ACCEPTANCE_SOURCE:sha,RAIL_BROWSER_EVIDENCE:output+'.browser.json'}});
 results.push({id:task.id,status:run.status===0?'passed':'failed',exitCode:run.status,signal:run.signal,error:run.error?.message,durationMs:Date.now()-start});
 if(run.status!==0)break;
}
for(const task of plan.tasks)if(!results.some(r=>r.id===task.id))results.push({id:task.id,status:'not-run'});
let evidence=null;const evidenceFile=flag('--scenario-evidence');if(evidenceFile)evidence=JSON.parse(fs.readFileSync(path.resolve(evidenceFile),'utf8'));
const bound=evidence?.source===sha;
const scenarios=plan.requiredScenarios.map(id=>({id,status:bound&&evidence.scenarios?.find(s=>s.id===id)?.status==='passed'?'passed':'not-run'}));
const measured=bound&&plan.performance.requiredMetrics.every(key=>Number.isFinite(evidence?.performance?.[key]));
const complete=results.every(r=>r.status==='passed')&&scenarios.every(s=>s.status==='passed')&&measured;
const artifacts={};for(const file of ['rail/wasm/rail-core-v33.wasm','scripts/fixtures/rail-session-contract-v9.wasm'])if(fs.existsSync(path.join(root,file)))artifacts[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const report={schemaVersion:1,source:sha,completedAt:new Date().toISOString(),status:complete?'accepted':'incomplete',tasks:results,scenarios,performance:measured?evidence.performance:{status:'not-measured'},artifacts};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({source:sha,status:report.status,report:output}));if(!complete)process.exitCode=1;
