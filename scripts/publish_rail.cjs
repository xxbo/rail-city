/* Explicit current publication surface. Development files are never copied. */
const fs=require('node:fs'),path=require('node:path');
const manifest=require('./rail-public-assets.json');
function stage(source,target,provenance={}){
 const game=path.join(source,'rail');
 if(fs.existsSync(target)&&fs.readdirSync(target).length)throw Error('Publication target must be empty');
 for(const entry of fs.readdirSync(game,{recursive:true}))if(fs.lstatSync(path.join(game,entry)).isSymbolicLink())throw Error('Game contains a symlink');
 const unique=new Set();
 for(const entry of manifest.files){
  if(!entry||path.isAbsolute(entry)||entry.split(/[\\/]/).includes('..')||unique.has(entry))throw Error('Invalid publication entry: '+entry);unique.add(entry);
  const src=path.join(game,entry);if(!fs.lstatSync(src).isFile())throw Error('Missing publication file: '+entry);
 }
 fs.mkdirSync(target,{recursive:true});
 for(const entry of manifest.files){const dest=path.join(target,entry);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(game,entry),dest);}
 fs.writeFileSync(path.join(target,'.nojekyll'),'');
 fs.writeFileSync(path.join(target,'deployment.json'),JSON.stringify({kind:'rail-city',...provenance},null,2)+'\n');
}
if(require.main===module)stage(process.argv[2]||'.',process.argv[3]||'_site',{repository:process.env.GITHUB_REPOSITORY,source:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID});
module.exports={stage,manifest};
