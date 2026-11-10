/* Discover every regression suite. --continue collects all failures; neither
   mode treats missing, timed-out or failed suites as success. */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),keepGoing=process.argv.includes('--continue');
const reportPath=process.argv.find(v=>v.startsWith('--report='))?.slice(9),results=[];
function run(id,args){const at=Date.now();const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',timeout:180000});const row={id,status:result.status===0?'passed':'failed',exitCode:result.status,signal:result.signal,error:result.error?.message,durationMs:Date.now()-at};results.push(row);console.log(JSON.stringify(row));if(reportPath)fs.writeFileSync(reportPath,JSON.stringify({results},null,2)+'\n');if(row.status==='failed'&&!keepGoing)process.exit(result.status||1);}
for(const file of fs.readdirSync(path.join(root,'rail')).filter(f=>f.endsWith('.js')).sort())run('syntax:'+file,['--check',path.join('rail',file)]);
const suites=fs.readdirSync(__dirname).filter(file=>/^test_rail.*\.cjs$/.test(file)).sort();
for(const file of suites){console.log('Running '+file);run(file,[path.join('scripts',file)]);}
const failed=results.filter(r=>r.status==='failed');console.log(JSON.stringify({scope:'all discovered Node regressions',suites:suites.length,failed:failed.map(r=>r.id),status:failed.length?'failed':'passed'}));if(failed.length)process.exitCode=1;
