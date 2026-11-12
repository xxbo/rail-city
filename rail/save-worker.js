/* Cold interchange compatibility port; production checkpoints are encoded by
   their owning simulation worker and do not traverse this worker. */
importScripts('value-wire.js?v=73','bootstrap-wasm.js?v=74','routing-wasm.js?v=76');
self.onmessage=async({data})=>{try{await RailRouting.init();const result=RailBootstrap.persistence('encode',{value:data.value});self.postMessage({id:data.id,text:result.text});}catch(error){self.postMessage({id:data.id,error:error.message});}};
