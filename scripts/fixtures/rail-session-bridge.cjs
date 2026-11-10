/* Test-only ABI forwarding. All session/revision/command decisions execute in Rust. */
const fs=require('node:fs'),path=require('node:path'),Wire=require('../../rail/value-wire');
function create(){let exports;
 const instance=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'rail-session-contract-v1.wasm'))),{
  rail_math:{exp:Math.exp,log:Math.log,hypot:Math.hypot,sin:Math.sin,acos:Math.acos,atan2:Math.atan2,random:Math.random,log1p:Math.log1p,pow:Math.pow,now:()=>performance.now()},
  rail_host:{json_utf8:(p,n,target,capacity)=>{const b=new TextEncoder().encode(JSON.stringify(Wire.decode(new Float64Array(exports.memory.buffer,p,n)).value));if(capacity)new Uint8Array(exports.memory.buffer,target,b.length).set(b);return b.length;}}
 });exports=instance.exports;
 function wire(input){const p=exports.input_resize(input.length);new Float64Array(exports.memory.buffer,p,input.length).set(input);const out=exports.session_contract(),result=new Float64Array(exports.memory.buffer,out,exports.output_len()).slice();exports.output_clear();return result;}
 return {request:input=>Wire.decode(wire(Wire.encode(input))).value,wire,exports};
}
module.exports={create};
