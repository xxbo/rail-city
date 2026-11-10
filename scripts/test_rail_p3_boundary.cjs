/* Verify review coverage and deliberately try to escape the production boundary. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const audit=require('./audit_rail_p3.cjs');
(async()=>{
 const inventory=await audit.check();assert.equal(Object.keys(inventory.files).length,77);assert.equal(inventory.workerEntries.length,5);
 for(const worker of ['save','simulation','demand','operations','vector'])assert(inventory.workerEntries.includes('rail/'+worker+'-worker.js'));
 let count=0;for(const [file,row]of Object.entries(inventory.files)){assert(row.sha256&&row.owner&&row.phase,file);for(const f of row.functions){assert(f.owner&&f.phase&&f.sha256&&f.line<=f.end,file+' '+f.id);count++;}}
 assert(count>=1800);assert.equal(inventory.files['rail/passengers.js'].functions.find(f=>f.name==='compactDefinitions').phase,'P3-4');
 assert.equal(inventory.files['rail/ui.js'].functions.find(f=>f.name==='saveNow').phase,'P3-7');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rail-p3-boundary-'));
 try{
  fs.cpSync(path.join(audit.root,'rail'),path.join(temp,'rail'),{recursive:true});fs.mkdirSync(path.join(temp,'scripts'));
  for(const f of fs.readdirSync(path.join(audit.root,'scripts')).filter(f=>/^test_rail.*\.cjs$/.test(f)))fs.copyFileSync(path.join(audit.root,'scripts',f),path.join(temp,'scripts',f));
  const mutate=async(file,text)=>{const p=path.join(temp,file),old=fs.readFileSync(p,'utf8');fs.writeFileSync(p,old+text);try{await assert.rejects(audit.check(temp));}finally{fs.writeFileSync(p,old);}};
  await mutate('rail/ui.js','\nfunction unreviewedBusinessRule(){ return 123; }\n');
  await mutate('rail/index.html','\n<script src="unreviewed.js"></script>');
  await mutate('rail/ui.js','\nnew Worker("unreviewed-worker.js");');
  await mutate('rail/save-store.js','\nnew root.Worker("another-worker.js");');
  await mutate('rail/ui.js','\nnew Worker(window.workerSource);');
  fs.writeFileSync(path.join(temp,'rail/new-business.js'),'const hidden = () => 2;');await assert.rejects(audit.check(temp));fs.unlinkSync(path.join(temp,'rail/new-business.js'));
  await audit.check(temp);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
 console.log(`P3-0 boundary: ${count} functions, 77 modules, page and five workers; new rules, unknown files, dynamic workers and unreviewed entries rejected.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
