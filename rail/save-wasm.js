/* Packed compatibility port for native save rules. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
function run(op,args={}){const Editor=node?require('./editor-wasm'):root.RailEditor,TX=node?require('./transactions-wasm'):root.RailTransactions;Editor.ensure();return TX.run(50,{op,...args});}
const api={run};if(node)module.exports=api;else root.RailSave=api;
})(typeof globalThis!=='undefined'?globalThis:this);
