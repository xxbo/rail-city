// node experiments/tokyo-play/build.cjs OUTPUT.html (after build_rail_wasm.cjs)
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
const rail = path.resolve(here, '../../rail');
const core = require('../../scripts/rail-public-assets.json').core;
const local = name => fs.readFileSync(path.join(here, name), 'utf8');
const adapters = ['routing-wasm','value-wire','bootstrap-wasm','transactions-wasm','editor-wasm','service-plan','forecast-catalog','demand-world'];
const marker = /new URL\('wasm\/rail-core-v\d+\.wasm\?v=\d+',\s*root\.document\?\.currentScript\?\.src \|\| root\.location\.href\)\.href/;
const worker = adapters.map(name => {
  let body = fs.readFileSync(path.join(rail, name + '.js'), 'utf8');
  if (name === 'routing-wasm') {
    if (!marker.test(body)) throw Error('Update the offline WASM asset binding');
    body = body.replace(marker, () => JSON.stringify('data:application/wasm;base64,' + fs.readFileSync(path.join(rail, core)).toString('base64')));
  }
  return body;
}).concat(local('worker.js')).join('\n');
if (!process.argv[2]) throw Error('Specify the output HTML path');
fs.writeFileSync(process.argv[2], local('page.html').replace('/* STYLES */', () => local('play.css'))
  .replace('/* WORKER */', () => worker.replace(/<\/script/gi, '<\\/script')).replace('/* SCENE */', () => local('scene.js'))
  .replace('/* PLAY */', () => local('play.js')));
