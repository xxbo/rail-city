/* Object/binary boundary for the complete Rust forecast. No spatial or allocation decisions here. */
(function(root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const Core = node ? require('./routing-wasm') : root.RailRouting;
  const X = node ? require('./service-plan') : root.RailServicePlan;
  const B = node ? require('./bootstrap-wasm') : root.RailBootstrap;
  const FIELDS = ['people','jobs','shops','industry','leisure'];
  const PURPOSES = ['work','shopping','leisure'], MODES = ['walk','bike','bus'];
  const KINDS = ['visitor-arrival','visitor-return','staff-outbound','staff-homebound','local-departure','local-return'];
  const tokens = new WeakMap();
  const CELL_FIELDS=['x','y','w','h','area',...FIELDS,'factory','survey'];
  const CELL_WIDTH=CELL_FIELDS.length+1;
  function writeCells(values, at, cells) {
    for(const cell of cells) {
      for(const key of CELL_FIELDS) values[at++]=cell[key];
      values[at++]=+!!cell.populationValid;
    }
    return at;
  }
  function encode(state,city,adj=null,command=null) {
    if (!tokens.has(city)) tokens.set(city,B.forecast('cityIdentity'));
    const {region,routeModel,operatingPlan,services,urban,economy}=state;
    const {head,tail,hubs,effective}=B.forecast('worldInput',{
      token:tokens.get(city),graphId:adj ? Core.forecastGraphId(state,adj) : undefined,
      state:{region,routeModel,operatingPlan,services,nodes:state.nodes.map(({x,y})=>({x,y})),
        tracks:state.tracks.map(({id,km})=>({id,km})),economy:{minute:economy?.minute},
        urban:urban && {version:urban.version,step:urban.step}},
      city:{count:city.cells.length,totals:city.totals,effectiveConnections:city.metadata?.effectiveConnections,
        demandZoneUnits:city.metadata?.demandZoneUnits}
    });
    const start=command===null?0:1;
    const values=new Float64Array(start+head.length+city.cells.length*CELL_WIDTH+tail.length);
    if(start)values[0]=command;
    values.set(head,start);
    const at=writeCells(values,start+head.length,city.cells);
    values.set(tail,at);
    return {values,state,city,hubs,tracks:state.tracks.map(t=>t.id),effective};
  }

  function cursor(data) {
    let at=0;
    return {f(){if(at>=data.length) throw Error('批量预测结果不完整');return data[at++];},
      take(n){if(at+n>data.length)throw Error('批量预测结果尺寸无效');const v=data.subarray(at,at+n);at+=n;return v;},
      position(){return at;},done(){if(at!==data.length)throw Error('批量预测结果含多余数据');}};
  }
  function fields(r,keys){return Object.fromEntries(keys.map(k=>[k,r.f()]));}
  function readCatchment(r,city) {
    const [covered,accessible,total,count]=r.take(4), stations={}, mapping=new Map();
    for(let i=0;i<count;i++){const id=r.f();stations[id]=fields(r,[...FIELDS,'walk','cells']);}
    const maps=r.f();
    for(let i=0;i<maps;i++) {
      const [cellIndex,id,walk,n]=r.take(4), access=[];
      for(let j=0;j<n;j++) {
        const id=r.f(),mode=MODES[r.f()];
        access.push({id,mode,...fields(r,['share','walk','time','accessCost','x','y'])});
      }
      mapping.set(city.cells[cellIndex].id,{id,walk,access});
    }
    return {stations,mapping,covered,accessible,total};
  }
  function readBudgets(r,matched) {
    return Object.fromEntries(PURPOSES.map(k=>{const [nominal,capacity,outbound,m]=r.take(4);return [k,{nominal,capacity,outbound,...(matched?{matched:m}:{})}];}));
  }
  function assign(state,city) {
    const e=encode(state,city,null,0), out=Core.kernel('world_run',e.values);
    const r=cursor(out), result=readCatchment(r,city);r.done();return result;
  }
  function choices(p,stations,feeders=true) {
    const values=[3,p.x,p.y,+feeders,stations.length];
    for(const n of stations)values.push(n.id,n.x,n.y);
    const r=cursor(Core.kernel('world_run',values)), result=[],n=r.f();
    for(let i=0;i<n;i++){
      const [id,km,time,mode,accessCost,weight,share]=r.take(7);
      result.push({id,km,time,mode:MODES[mode],accessCost,weight,share});
    }
    r.done();return result;
  }
  function local(city,p,radius=.8) {
    const values=new Float64Array(5+city.cells.length*CELL_WIDTH);
    values.set([2,p.x,p.y,radius,city.cells.length]);
    writeCells(values,5,city.cells);
    const r=cursor(Core.kernel('world_run',values));
    const out=fields(r,[...FIELDS,'cells','area','factory','surveyArea','populationArea']);r.done();return out;
  }
  function distribution(city) {
    const state={nodes:[],services:[],tracks:[],companies:[],region:city.metadata?.region};
    const e=encode(state,city,null,1),r=cursor(Core.kernel('world_run',e.values)),n=r.f(),zones=[];
    for(let i=0;i<n;i++){
      const [bx,by]=r.take(2),z={key:bx+':'+by,...fields(r,['x','y','count','area',...FIELDS])},count=r.f();
      z.cells=Array.from(r.take(count),ix=>city.cells[ix]);zones.push(z);
    }
    const budgets=readBudgets(r,true),[ipfError,ipfIterations]=r.take(2);r.take(3);
    const matrices=Object.fromEntries(PURPOSES.map(p=>[p,r.take(n*n)]));r.done();
    const result={city,zones,matrices,diagnostics:{ipfError,ipfIterations,...(e.effective?{activityBudgets:budgets}:{})}};
    return result;
  }
  function readStats(r){const o=fields(r,['entries','limit','peak','hits','misses','evictions','weight','maxWeight','peakWeight','oversized']);if(!Number.isFinite(o.maxWeight))o.maxWeight=null;return o;}
  function readForecast(data,context) {
    const {state:s,city,hubs,tracks,effective,graph,started}=context,r=cursor(data);
    if(r.f()!==1)throw Error('批量预测接口版本不匹配');
    const populated=!!r.f();r.f();
    const [totalTrips,uncoveredTrips,riders,unserved,work,shopping,leisure,connectedDemand,eligiblePairs,zones,ipfError,ipfIterations]=r.take(12);
    const activityBudgets=readBudgets(r,populated),catchment=readCatchment(r,city);
    const base={city:true,flows:[],trackFlow:{},trackLoad:{},serviceFlow:{},riders,unserved,totalTrips,uncoveredTrips,
      purposeTotals:{work,shopping,leisure},catchment,population:city.totals.people,jobs:city.totals.jobs,hubStats:{},connectionModel:effective?36:null,
      diagnostics:{model:effective?'effective-connections-v36':s.urban?'transit-urban-growth-v19':'hub-corridor-progression-v17',...(effective?{activityBudgets}:{})}};
    const nh=r.f();
    for(let i=0;i<nh;i++) {
      const [marketActivation,riders,arrivals,departures,staffRiders,passengerRiders,visitorDestinationScale,visitorDestinationCapacity,corridorCapture,corridorMass,development,n]=r.take(12);
      const {id,envelope,railReference,referenceTarget}=hubs[i],connections=[];
      for(let j=0;j<n;j++){const[id,walk,share]=r.take(3);connections.push({id,walk,share});}
      base.hubStats[id]={...envelope,railReference,referenceTarget,marketActivation,riders,arrivals,departures,staffRiders,passengerRiders,connections,
        ...(populated&&effective?{visitorDestinationScale,visitorDestinationCapacity}:{}),...(populated?{corridorCapture,corridorMass,development}:{})};
    }
    for(const [key,ids] of [['trackFlow',tracks],['trackLoad',tracks],['serviceFlow',graph.lines]]){
      const n=r.f();for(let i=0;i<n;i++){const id=r.f();base[key][ids[id]]=r.f();}
    }
    const nf=r.f(),flowStart=r.position();let railDemand=0;
    const owned=(node?require('./forecast-catalog'):root.RailForecastCatalog).attachOutput(base,{count:nf,graph:{services:graph.services,lines:graph.lines,edges:graph.edges},hubs:hubs.map(h=>h.id),effective},data.subarray(flowStart),!context.compact);
    if(context.compact){r.take(owned.flowLength);railDemand=owned.railDemand;}
    else for(let i=0;i<nf;i++){
      const [from,to,purpose,back,trips,demandTrips,population,walk,rail,road,hub,kind,routeOptions]=r.take(13);
      const [service,dir,lastLine,fareKm,board,cost,minutes,fare,km,transfers,ne]=r.take(11);
      const edges=Array.from(r.take(ne),ix=>graph.edges[ix]),nfare=r.f(),fares={};
      for(let j=0;j<nfare;j++){const id=r.f();fares[graph.lines[id]]=r.f();}
      railDemand+=demandTrips;
      const path={service:graph.services[service],dir,lastLine:graph.lines[lastLine],fareKm,board,cost,minutes,fare,km,edges,transfers,fares};
      base.flows.push({from,to,purpose:PURPOSES[purpose],back:!!back,trips,demandTrips,path,population,walk,rail,road,hub:hub<0?null:hubs[hub].id,externalKind:kind<0?null:KINDS[kind],...(effective?{routeOptions}:{})});
    }

    if(populated){
      const routeTrees=readStats(r),strategies=readStats(r);
      Object.assign(base.diagnostics,{ipfError,ipfIterations,connectedDemand,railDemand,zones,eligiblePairs,
        calculationMs:Date.now()-started,accessSampling:16,memory:{routeTrees,strategies,routing:'rust-wasm-abi1',demand:'rust-wasm-forecast-abi1',wasm:Core.status()}});
    }
    r.done();return base;
  }
  function evaluate(state,city,options={}){const started=Date.now(),adj=X.network(state),e=encode(state,city,adj);return Core.forecastKernel(state,adj,e.values,readForecast,{...e,started,compact:!!options.compact});}
  const api={assign,local,choices,distribution,evaluate};
  if(node)module.exports=api;else root.RailDemandWorld=api;
})(typeof globalThis!=='undefined'?globalThis:this);
