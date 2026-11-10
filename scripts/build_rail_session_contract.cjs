/* Versioned session ABI artifact; the frozen v1 oracle remains untouched. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),crate=path.join(root,'rust/rail-routing'),cargo=process.env.RAIL_CARGO||'cargo';
for(const args of [['test','--locked','--features','session-contract'],['build','--locked','--release','--features','session-contract','--target','wasm32-unknown-unknown']]){
 const r=spawnSync(cargo,[...args,'--manifest-path',path.join(crate,'Cargo.toml')],{cwd:crate,stdio:'inherit',env:{...process.env,CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS:'-C link-arg=--max-memory=268435456'}});if(r.status!==0)process.exit(r.status||1);
}
const bytes=fs.readFileSync(path.join(crate,'target/wasm32-unknown-unknown/release/rail_routing.wasm')),target=path.join(__dirname,'fixtures/rail-session-contract-v2.wasm');
if(process.argv.includes('--check')){if(!fs.readFileSync(target).equals(bytes))throw Error('Session prototype is not the pinned source build');}else fs.writeFileSync(target,bytes);
console.log(JSON.stringify({scope:'P3-1 session ABI; v1 preserved as frozen oracle',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));
