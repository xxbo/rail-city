/* AST inventory and reviewed production boundary. No runtime dependency or npm install. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'), sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const parseModule=()=>import('./rail-vendor/acorn-8.15.0/src/index.js');
function walk(node,fn,parents=[]){if(!node||typeof node.type!=='string')return;fn(node,parents);for(const[k,v]of Object.entries(node)){if(k==='loc')continue;if(Array.isArray(v))for(const x of v)walk(x,fn,[...parents,node]);else if(v&&typeof v.type==='string')walk(v,fn,[...parents,node]);}}
const isFunction=n=>['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(n.type);
function name(n,p){if(n.id?.name)return n.id.name;const a=p.at(-1);if(a?.type==='VariableDeclarator')return a.id.name||'<destructure>';if(a?.type==='Property'||a?.type==='MethodDefinition')return a.key.name||String(a.key.value);if(a?.type==='AssignmentExpression')return a.left.property?.name||a.left.name||'<assignment>';return a?.type==='CallExpression'&&a.callee===n?'<iife>':`<callback:${n.loc.start.line}:${n.loc.start.column}>`;}
const value=n=>n?.type==='Literal'&&typeof n.value==='string'?n.value:null;
const member=n=>n?.type==='MemberExpression'?(n.computed?value(n.property):n.property.name):null;
const nodeFixtures=new Set(['engine-wasm','preparation-wasm','simulation-client','simulation-wasm','queue-runtime'].map(n=>'scripts/fixtures/rail-p3-6-'+n+'.cjs').concat('scripts/fixtures/rail-p3-8-ridership.cjs','scripts/fixtures/rail-map56-flow-history.cjs'));
function localRef(file,ref){if(!ref||/^(?:node:|https?:|data:|blob:)/.test(ref))return null;let p=path.posix.normalize(path.posix.join(path.posix.dirname(file),ref.split(/[?#]/)[0]));if(!path.posix.extname(p))p+='.js';if(!p.startsWith('rail/')&&!nodeFixtures.has(p))throw Error('Dependency escapes rail/: '+p);return p;}
async function scan(base=root){
 const {parse}=await parseModule(),files=fs.readdirSync(path.join(base,'rail')).filter(x=>x.endsWith('.js')).sort(),data={};
 for(const f of files){const file='rail/'+f,source=fs.readFileSync(path.join(base,file),'utf8'),ast=parse(source,{ecmaVersion:2024,sourceType:'script',locations:true,allowAwaitOutsideFunction:true}),functions=[],refs=[],globals=[],uses=[],objects=new Map(),exportCandidates=[];
  walk(ast,(n,p)=>{
   const keys=o=>o?.type==='ObjectExpression'?o.properties.filter(x=>x.type==='Property').map(x=>x.key.name||value(x.key)).filter(Boolean):[];
   if(n.type==='VariableDeclarator'&&n.id.name&&n.init?.type==='ObjectExpression')objects.set(n.id.name,keys(n.init));
   if(n.type==='AssignmentExpression'&&n.left.type==='MemberExpression'&&((n.left.object.name==='module'&&member(n.left)==='exports')||['root','self','globalThis'].includes(n.left.object.name)))exportCandidates.push(...(n.right.type==='Identifier'?objects.get(n.right.name)||[]:keys(n.right)));
   if(isFunction(n)){const label=name(n,p),scope=p.filter(isFunction).map((x,i,a)=>name(x,p.slice(0,p.indexOf(x))));functions.push({id:`${scope.join('/')}/${label}@${n.loc.start.line}:${n.loc.start.column}`,name:label,line:n.loc.start.line,end:n.loc.end.line,sha256:sha(source.slice(n.start,n.end)),scope:scope.filter(x=>!x.startsWith('<'))});}
   if(n.type==='MemberExpression'&&member(n))uses.push({name:member(n),line:n.loc.start.line});
   if(n.type==='Identifier')uses.push({name:n.name,line:n.loc.start.line});
   if(n.type==='AssignmentExpression'&&n.left.type==='MemberExpression'&&['root','self','globalThis'].includes(n.left.object?.name))globals.push(member(n.left));
   const prop=['NewExpression','CallExpression'].includes(n.type)?(n.callee.name||member(n.callee)):null;
   if(prop==='require'){const ref=value(n.arguments[0]);if(ref?.startsWith('.')){const target=localRef(file,ref),fixture=nodeFixtures.has(target);if(fixture&&!p.some(a=>a.type==='IfStatement'&&(a.test.name==='node'||source.slice(a.test.start,a.test.end).includes("typeof module"))))throw Error('Unguarded development fixture '+file+':'+target);refs.push({kind:fixture?'node-fixture':'require',target,line:n.loc.start.line});}}
   if(prop==='importScripts')for(const arg of n.arguments){const ref=value(arg);if(!ref)throw Error('Unresolved importScripts in '+file);refs.push({kind:'importScripts',target:localRef(file,ref),line:n.loc.start.line});}
   if(prop==='Worker'){let arg=n.arguments[0];if(arg?.type==='NewExpression'&&arg.callee.name==='URL')arg=arg.arguments[0];if(arg?.type==='CallExpression'&&member(arg.callee)==='join'&&arg.arguments[0]?.name==='__dirname'&&arg.arguments.length===2)arg=arg.arguments[1];const ref=value(arg);if(ref)refs.push({kind:'worker',target:localRef(file,ref),line:n.loc.start.line});else if(file!=='rail/simulation-client.js')throw Error('Unresolved Worker in '+file+':'+n.loc.start.line);}
   if(prop==='URL'){const ref=value(n.arguments[0]);if(ref?.split(/[?#]/)[0].endsWith('.wasm'))refs.push({kind:'asset',target:localRef(file,ref),line:n.loc.start.line});}
  });
  // Node's simulation worker uses path.join(__dirname,...) rather than browser URL.
  if(file==='rail/simulation-client.js')refs.push({kind:'node-worker',target:'rail/simulation-worker.js',line:14});
  data[file]={sha256:sha(source),functions,refs:[...new Map(refs.map(x=>[x.kind+':'+x.target,x])).values()].sort((a,b)=>a.target.localeCompare(b.target)||a.kind.localeCompare(b.kind)),globals:[...new Set(globals.filter(Boolean))].sort(),exports:[...new Set(exportCandidates)].sort(),uses};
 }
 const html=fs.readFileSync(path.join(base,'rail/index.html'),'utf8'),entries=[...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(x=>localRef('rail/index.html',x[1]));
 const workerEntries=[...new Set(Object.values(data).flatMap(x=>x.refs.filter(r=>/worker/.test(r.kind)).map(r=>r.target)))].sort();
 const closures={};for(const entry of ['page',...workerEntries]){const visited=new Set(),todo=entry==='page'?[...entries]:[entry];while(todo.length){const file=todo.pop();if(visited.has(file))continue;if(!data[file])throw Error('Missing runtime source '+file);visited.add(file);for(const r of data[file].refs)if(r.kind!=='require'&&r.kind!=='node-fixture'&&r.kind!=='asset'&&!/worker/.test(r.kind))todo.push(r.target);}closures[entry]=[...visited].sort();}
 const testUses=new Map();for(const f of fs.readdirSync(path.join(base,'scripts')).filter(x=>/^test_rail.*\.cjs$/.test(x))){const s=fs.readFileSync(path.join(base,'scripts',f),'utf8');for(const x of s.matchAll(/\b(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*\(/g)){if(!testUses.has(x[1]))testUses.set(x[1],new Set());testUses.get(x[1]).add('scripts/'+f);}}
 return {data,entries,workerEntries,closures,testUses};
}
function classify(file,f,policy){const rule=policy.files[file];if(!rule)throw Error('Unclassified file '+file);const anchor=[f.name,...f.scope.toReversed()];const override=anchor.map(x=>rule.overrides?.[x]).find(Boolean);return override||{role:rule.role,phase:rule.phase,owner:rule.owner};}
async function inventory(base=root){const s=await scan(base),policy=JSON.parse(read('scripts/rail-p3-boundary-policy.json')),out={schemaVersion:1,baseline:'bffdd8fbd22e2553a881533b540f878f6ea8fabc',parser:'Acorn 8.15.0 (vendored source)',notes:'References are conservative syntactic candidates, not proof of reachability or dead code. Function phase inherits the nearest reviewed named scope; module-level data/defaults follow the file owner.',entries:s.entries,workerEntries:s.workerEntries,closures:s.closures,files:{}};
 for(const[file,row]of Object.entries(s.data)){const scopes=Object.entries(s.closures).filter(([,list])=>list.includes(file)).map(([k])=>k);out.files[file]={sha256:row.sha256,role:policy.files[file]?.role,owner:policy.files[file]?.owner,phase:policy.files[file]?.phase,contexts:scopes,globals:row.globals,exports:row.exports,dependencies:row.refs,functions:row.functions.map(f=>{const candidates=Object.entries(s.data).filter(([p,r])=>p!==file&&r.uses.some(x=>x.name===f.name)).map(([p])=>p);return{...f,...classify(file,f,policy),exportNameCandidate:row.exports.includes(f.name),productionReferenceCandidates:f.name.startsWith('<')?[]:candidates,testReferenceCandidates:[...(s.testUses.get(f.name)||[])].sort(),disposition:'reviewed-migration-target; no dead-code inference'};})};}
 return out;
}
async function check(base=root){const actual=await inventory(base),expected=JSON.parse(read('scripts/fixtures/rail-p3-production-inventory.json'));if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Production AST/entry/function boundary changed. Review the per-function migration dispositions, then regenerate the inventory explicitly.');
 const files=Object.keys(actual.files),policy=JSON.parse(read('scripts/rail-p3-boundary-policy.json'));if(JSON.stringify(files.sort())!==JSON.stringify(Object.keys(policy.files).sort()))throw Error('Boundary policy has missing or obsolete files');
 for(const[file,rule]of Object.entries(policy.files)){if(!rule.owner||!rule.phase||!['ui','domain','mixed','platform','data','test-reference'].includes(rule.role))throw Error('Incomplete policy '+file);if(['platform','test-reference'].includes(rule.role)&&!rule.bridgeDisposition)throw Error('Platform exception lacks a migration disposition '+file);}
 return actual;
}
if(require.main===module)(async()=>{const write=process.argv.includes('--write'),result=write?await inventory():await check();if(write)fs.writeFileSync(path.join(root,'scripts/fixtures/rail-p3-production-inventory.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({files:Object.keys(result.files).length,functions:Object.values(result.files).reduce((n,r)=>n+r.functions.length,0),pageScripts:result.entries.length,workers:result.workerEntries,mode:write?'review snapshot written':'boundary checked'}));})().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={scan,inventory,check,root,sha};
