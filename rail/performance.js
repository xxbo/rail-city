/* Presentation budgets never change passenger counts, fares or operating rules. */
(function(root) {
  'use strict';
  const MODES = {
    auto: {
      name: '自动',
      fps: 30,
      hud: 750,
      budget: 6
    },
    smooth: {
      name: '流畅',
      fps: 45,
      hud: 500,
      budget: 8
    },
    balanced: {
      name: '均衡',
      fps: 24,
      hud: 1000,
      budget: 6
    },
    economy: {
      name: '省电',
      fps: 12,
      hud: 1800,
      budget: 4
    }
  };

  function settings(value) {
    return {
      mode: MODES[value?.mode] ? value.mode : 'auto',
      trainLabels: value?.trainLabels !== false,
      queueLabels: value?.queueLabels !== false,
      detail: ['auto', 'full', 'trains', 'stations'].includes(value?.detail) ? value.detail : 'auto'
    };
  }

  function resolve(p, load = 0) {
    return MODES[p.mode === 'auto' ? (load > 160 ? 'economy' : load > 60 ? 'balanced' : 'auto') : p.mode] ||
      MODES.auto;
  }

  function createClock(){
    const B=()=>typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap;
    const id=B().clock('create'),call=(action,args={})=>B().clock(action,{id,...args});
    const check=view=>{if(view.fault)throw Error(view.fault);return view;};
    function runBudget(elapsed,speed,budget,advance,now){const start=now(),view=check(call('begin',{elapsed,speed,budget})),request=view.request;if(!request)return view;try{const result=advance(request.minutes,{budget:request.budget,maxSteps:request.maxSteps,now});return {...call('complete',{ticket:request.ticket,result,ms:now()-start}),steps:result.steps};}catch(error){call('fail',{ticket:request.ticket,fault:error.message});throw error;}}
    return{reset:()=>call('reset'),get pending(){return call('status').pending;},
      runAsync(elapsed,speed,budget,advance,now){const view=check(call('begin',{elapsed,speed,budget})),request=view.request;if(request){const start=now();Promise.resolve().then(()=>advance(request.minutes,{budget:request.budget,maxSteps:request.maxSteps,now})).then(result=>call('complete',{ticket:request.ticket,result,ms:now()-start})).catch(error=>call('fail',{ticket:request.ticket,fault:error.message}));}return view;},
      runBudget,
      // Compatibility callback API; native control selects slices and owns their accounting.
      run(elapsed,speed,budget,advance,now){let view=check(call('compatStart',{elapsed,speed,budget,wall:now()}));if(!view.request)return {...view,steps:0};let previous=true;for(;;){view=call('compatNext',{wall:now(),previous});if(view.done)return view;previous=advance(view.dt)!==false;}},
      close:()=>call('close')
    };
  }

  const api = {
    MODES,
    settings,
    resolve,
    createClock
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailPerformance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
