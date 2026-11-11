/* Historical test input adapter. Callbacks stage detached command inputs only;
   the production API remains descriptor-only and Rust validates/charges the
   candidate through the same native asset transaction. Assertions are unchanged. */
const Native=require('../../rail/management'),Assets=require('../../rail/assets-wasm'),R=require('../../rail/engine');
const api=Object.defineProperties({},Object.getOwnPropertyDescriptors(Native));
function plan(state,operation,commit){if(typeof operation!=='function')return commit?Native.change(state,operation):Native.preview(state,operation);
 const after=R.clone(state),result=operation(after);if(result?.error)return result;
 const candidate=Assets.transaction(state,null,commit,after,result);if(candidate.error||!commit)return candidate;
 R.sync(state,candidate.after);Native.init(state);Native.settle(state);return {...candidate.result,quote:candidate};
}
api.change=(state,operation)=>{if(typeof operation!=='function')return Native.change(state,operation);Native.init(state);return plan(state,operation,true);};
api.preview=(state,operation)=>plan(state,operation,false);
module.exports=api;
