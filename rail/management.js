/* Save values use legacy accounting units; UI uses fixed CNY denomination; rates and costs are deliberately simplified game rules. */
(function(root) {
  'use strict';
  const node=typeof module!=='undefined'&&module.exports,R=node?require('./engine'):root.RailSim,BAL=node?require('./game-balance'):root.RailBalance;
  const Runtime=node?require('./runtime-wasm'):root.RailRuntime;
  const INITIAL = 5e9,
    CREDIT = 3e9,
    MAX_LOAN = 1e9,
    RATE = .0005,
    TERM = 30;

  const Assets = node ? require('./assets-wasm') : root.RailAssets;
  function init(s){const out=R.compat('managementInit',s);R.sync(s,out.state);return s;}
  const validate = s => Assets.query(s,'validateEconomy');
  const quote = (before,after) => Assets.run(before,'quote',{}, {after:Assets.snapshot(after)}).result;

  // A descriptor lets the native core edit, validate, quote and pay in one call.
  const command = (kind,op,args={}) => ({kind,op,args});
  function plan(s,operation,commit){if(!operation||typeof operation!=='object')throw TypeError('编辑操作须使用结构化命令。');return Assets.transaction(s,operation,commit);}
  const preview = (s,operation) => plan(s,operation,false);
  function change(s,operation){if(!operation||typeof operation!=='object')throw TypeError('编辑操作须使用结构化命令。');const out=R.compat('assetChange',s,{command:operation});if(!out.result?.error)R.sync(s,out.state);return out.result;}

  function coldAccount(s, creditAction, args={}) {
    const owner=node?require('./bootstrap-wasm'):root.RailBootstrap;
    const result=owner.viewModel('coldAccount',{economy:s.economy,creditAction,...args});
    R.sync(s.economy,result.economy);
    return result.credit;
  }
  function available(s) {
    init(s);
    return coldAccount(s, 0).available;
  }

  const CREDIT_ERRORS = [null,
    '贷款额度不足：最多 3 笔，未偿本金合计不超过 1.5 亿元人民币，每笔 500 万—5000 万元。',
    '贷款不存在。', '余额不足以结清这笔贷款。'
  ];

  function borrow(s, amount) {
    init(s);
    const result = coldAccount(s, 1, {amount});
    return result.error ? {
      error: CREDIT_ERRORS[result.error]
    } : {};
  }

  function repay(s, id) {
    init(s);
    const result = coldAccount(s, 2, {loanId:id});
    return result.error ? {
      error: CREDIT_ERRORS[result.error]
    } : {};
  }

  function settle(s) {
    coldAccount(s, 0, {settle:true});
    return !s.economy.blocked;
  }

  const advance=(s,rt,minutes)=>Runtime.advance(s,rt,minutes,{full:true}).running;
  const advanceBudget=(s,rt,minutes,options={})=>Runtime.advance(s,rt,minutes,options);
  const advanceBudgetAsync=(s,rt,minutes,options={})=>Runtime.advanceAsync(s,rt,minutes,options);
  const whenIdle=rt=>Runtime.idle(rt);
  function signature(s) {return (node?require('./save-wasm'):root.RailSave).run('signature',{state:s});}
  const api = {
    command,
    forecastBeginAsync:(rt,blocked,force)=>Runtime.forecastBegin(rt,blocked,force),forecastFinishAsync:(rt,ticket,success)=>Runtime.forecastFinish(rt,ticket,success),
    invalidateForecastAsync:rt=>Runtime.forecastInvalidate(rt),diagnoseAsync:(rt,query)=>Runtime.diagnose(rt,query),observeAsync:(rt,id)=>Runtime.observe(rt,id),forecastQueryAsync:(rt,query,args)=>Runtime.forecastQuery(rt,query,args),
    changeAsync:(s,rt,operation,undo=false)=>Runtime.command(rt,operation,undo).then(out=>({...out.result,quote:out.quote,undoToken:out.undoToken})),
    previewAsync:(s,rt,operation)=>Runtime.preview(rt,operation),
    undoAsync:(rt,token)=>Runtime.undo(rt,token),replaceDemandAsync:(rt,forecast,revision,ticket)=>Runtime.replaceDemand(rt,forecast,revision,ticket),editRevision:rt=>Runtime.editRevision(rt),
    init,
    validate,
    quote,
    preview,
    change,
    available,
    borrow,
    repay,
    settle,
    advance,
    borrowAsync:(s,rt,amount)=>Runtime.credit(rt,{creditAction:1,amount}).then(r=>r.error?{error:CREDIT_ERRORS[r.error]}:{}),
    repayAsync:(s,rt,loanId)=>Runtime.credit(rt,{creditAction:2,loanId}).then(r=>r.error?{error:CREDIT_ERRORS[r.error]}:{}),
    pulseAsync:(s,rt,intent)=>Runtime.pulse(s,rt,intent),runtimeIntent:(rt,intent)=>Runtime.intent(rt,intent),nativeRuntime:rt=>Runtime.has(rt),
    advanceBudget,advanceBudgetAsync,whenIdle,
    isBusy:rt=>Runtime.isBusy(rt),lastError:rt=>Runtime.lastError(rt),
    signature,
    INITIAL,
    CREDIT,
    MAX_LOAN,
    RATE,
    TERM,
    get TRACK(){return BAL.TRACK;},
    get STATION(){return BAL.STATION;},
    get CAR(){return BAL.CAR;}
  };
  if (node) module.exports = api;
  else root.RailManagement = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
