//! Native candidate planning. Runtime snapshots here never cross the platform boundary.
use crate::{editor_support::*,value::Value as V,forecast_session::ForecastOwner};
pub(super) fn apply(world:&mut V,patch:&V){
    for row in patch.array(){let r=row.array();let k=r[0].text();match r[1].n()as usize{
        0=>{},1=>{let old=world.get(k).array();let next=r[2].array().iter().map(|v|if v.array()[0].n()>=0.0{old[v.array()[0].n()as usize].clone()}else{v.array()[1].clone()}).collect();world.set(k,arr(next));},
        _=>{if k=="urban"{for(k,v)in r[2].entries(){world.get_mut("urban").set(k,v.clone());}}else{world.set(k,r[2].clone());}}
    }}
}
pub(super) fn graph(plan:&V,owner:&mut ForecastOwner)->Result<V,String>{
    let mut state=plan.clone();state.set("operatingPlan",boolean(true));for l in state.get_mut("services").array_mut(){if plan.num("routeModel")==9.0{l.set("fleet",n(l.num("fleet").max(1.0)));}l.set("dispatchCompiled",boolean(true));}
    let legacy=state.num("routeModel")!=9.0;
    let adjacency=if legacy{crate::legacy::graph(&state,&V::Missing)}else{crate::editor::graph(&state)?};
    let mut graph=owner.handle(&obj(&[("action",text("graphFrame")),("state",state.clone()),("adjacency",adjacency),("legacy",boolean(legacy))]));
    if graph.get("error").truth(){return Err(graph.get("error").text().into());}
    let id=graph.get("id").clone();let prices=owner.handle(&obj(&[("action",text("graphPrices")),("id",id.clone()),("state",state)]));
    owner.handle(&obj(&[("action",text("release")),("id",id)]));
    if prices.get("error").truth(){return Err(prices.get("error").text().into());}graph.set("prices",prices);
    graph.set("weights",arr(plan.get("services").array().iter().map(|l|arr(vec![l.get("id").clone(),n(headway(plan,l).unwrap_or(f64::INFINITY)),n(loop_dwell(plan,l).unwrap_or(0.6))])).collect()));Ok(graph)
}
fn signatures(plan:&V)->V{V::Object(plan.get("services").array().iter().map(|l|{
    let geometry=l.get("trackIds").array().iter().map(|id|crate::editor_geometry::track(plan,id).cloned().unwrap_or(V::Null)).collect();
    (l.get("id").text().into(),text(&crate::diagnostics::json(&arr(vec![l.get("stops").clone(),l.get("trackIds").clone(),if l.get("callStops").truth(){l.get("callStops").clone()}else{l.get("stops").clone()},arr(dirs(l).iter().map(|d|n(*d)).collect()),arr(geometry)]))))
}).collect())}
pub(super) struct Migration{pub saved:V,pub rejected:V,pub catalog:u64,pub routes:V,pub trees:V}
pub(super) fn migrate(world:&V,previous:&V,mut saved:V,catalog:u64,replacement:bool,owner:&mut ForecastOwner)->Result<Migration,String>{
    let mut plan=expanded(world,saved.num("minute"))?;for k in ["nodes","tracks","companies"]{plan.set(k,world.get(k).clone());}plan.set("baseLines",world.get("services").clone());
    let mut directions=obj(&[]);let mut headways=obj(&[]);let mut limits=obj(&[]);let cfg=crate::bootstrap::config();
    for l in plan.get("services").array(){directions.set(l.get("id").text(),arr(dirs(l).iter().map(|d|n(*d)).collect()));for d in dirs(l){headways.set(&format!("{}|{}",l.get("id").text(),d),n(headway(&plan,l)?));}
        for id in if l.get("callStops").truth(){l.get("callStops").array()}else{l.get("stops").array()}{let(a,b)=crate::save::limits(world,id.n()as usize,&cfg);limits.set(&jsstring(id),obj(&[("capacity",n(a)),("outsideCapacity",n(b))]));}}
    let graph=graph(&plan,owner)?;
    let count=owner.handle(&obj(&[("action",text("status")),("id",n(catalog as f64))]));if count.get("error").truth(){return Err(count.get("error").text().into());}
    // Keep the historical 55k edit boundary; only active identities survive compaction.
    if saved.get("defs").array().len()+count.num("count")as usize>55000{crate::migration::compact(&mut saved);}
    let result=crate::migration::reconcile(&obj(&[("runtime",saved),("previous",previous.clone()),("plan",plan.clone()),("oldSignatures",signatures(previous)),("newSignatures",signatures(&plan)),("directions",directions.clone()),("headways",headways),("limits",limits),("catalog",boolean(replacement)),("graph",graph)]));
    // A private catalog is staged. Failure never mutates the source daily-demand table.
    let mut indices=vec![];for i in 0..count.num("count")as usize{let legs=owner.handle(&obj(&[("action",text("legs")),("id",n(catalog as f64)),("index",n(i as f64))]));if legs.array().iter().all(|e|crate::migration::leg_valid(&plan,&directions,e)){indices.push(n(i as f64));}}
    let selected=owner.handle(&obj(&[("action",text("select")),("id",n(catalog as f64)),("indices",arr(indices))]));if selected.get("error").truth(){return Err(selected.get("error").text().into());}
    let mut saved=result.get("runtime").clone();saved.set("urbanDefs",saved.get("defs").clone());
    let routes=arr(result.get("routeCache").array().iter().map(|row|{let mut values=row.array().to_vec();if values[4].truth()||matches!(values[4],V::Number(_)){values[4]=saved.get("defs").array().get(values[4].n()as usize).cloned().unwrap_or(V::Null);}arr(values)}).collect());
    Ok(Migration{saved,rejected:result.get("rejected").clone(),catalog:selected.num("id")as u64,routes,trees:result.get("trees").clone()})
}
pub(super) fn review(world:&mut V,runtime:&V,op:&str,args:V)->V{
    let out=crate::diagnostic_review::run(&obj(&[("state",world.clone()),("runtime",runtime.clone()),("op",text(op)),("args",args)]),&crate::bootstrap::config());world.set("operationsReview",out.get("review").clone());out.get("result").clone()
}

// Reject a staged remap before installation if any cohort lost its definition or leg.
pub(super) fn valid_references(saved:&V)->bool{
    let defs=saved.get("defs").array();
    let valid=|id:usize,leg:usize|defs.get(id).is_some_and(|j|j.num("id")==id as f64&&leg<j.get("legs").array().len());
    let token=|key:&str|{let mut parts=key.split(':');let Some(id)=parts.next().and_then(|s|s.parse::<usize>().ok())else{return false;};let Some(leg)=parts.next().and_then(|s|s.parse::<usize>().ok())else{return false;};valid(id,leg)};
    for field in ["queues","outside"]{for(_,rows)in saved.get(field).entries(){if rows.entries().iter().any(|(key,_)|!token(key)){return false;}}}
    for train in saved.get("trains").array(){if train.get("passengers").entries().iter().any(|(key,_)|!token(key)){return false;}}
    for row in saved.get("transfers").array(){if !valid(row.num("journey")as usize,row.num("leg")as usize){return false;}}
    true
}
