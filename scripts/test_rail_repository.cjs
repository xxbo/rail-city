/* The game repository contains game code; storage compatibility names and navigation links are intentional. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
for(const file of ['data/dashboard.json','home-feed.js','feed.js','app.js','scripts/update_data.py','scripts/run_dashboard_tests.cjs','scripts/site_artifacts.cjs','scripts/select_publication.cjs','.github/workflows/refresh-dashboard.yml','.github/workflows/publish-site.yml'])assert(!fs.existsSync(path.join(root,file)),file);
assert.deepEqual(fs.readdirSync(path.join(root,'.github/workflows')),['game.yml']);
assert(fs.readdirSync(path.join(root,'scripts')).every(file=>file==='fixtures'||file.includes('rail')));
assert(fs.readdirSync(path.join(root,'scripts/fixtures')).every(file=>file.startsWith('rail-')));
const workflow=fs.readFileSync(path.join(root,'.github/workflows/game.yml'),'utf8');assert(!workflow.includes('update_data.py'));assert(!workflow.includes('dashboard-public'));assert(workflow.includes('run_rail_tests.cjs'));
assert(fs.readFileSync(path.join(root,'rail/save-store.js'),'utf8').includes('guanchao-rail-checkpoints'));
console.log('Repository boundary: no news pages/data/collectors/tests/workflows; game-only CI and historical storage names retained.');
