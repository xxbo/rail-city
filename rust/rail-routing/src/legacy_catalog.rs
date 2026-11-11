//! Ordinary historical forecasts enter the same owned catalog without JS identity compilation.
use crate::{editor_support::*,value::Value as V};
fn intern(rows:&mut Vec<V>,value:&V)->usize{if let Some(i)=rows.iter().position(|v|eq(v,value)){i}else{rows.push(value.clone());rows.len()-1}}
pub(super) fn encode(world:&V,forecast:&V)->Option<(V,Vec<f64>,Vec<f64>)>{
 let expanded=crate::editor_support::expanded(world,world.get("economy").zero("minute"));
 let s=match &expanded{Ok(plan)=>plan,Err(_)=>world};
 let supplied=matches!(forecast.get("preparedDefinitions"),V::Array(_));
 if !supplied&&forecast.get("flows").array().iter().any(|f|f.get("path").get("edges").array().iter().any(|e|!s.get("services").array().iter().any(|l|eq(l.get("id"),e.get("service"))))){return None;}
 let count=forecast.get(if supplied{"preparedDefinitions"}else{"flows"}).array().len();
 let(mut services,mut lines,mut edges,mut hubs)=(vec![text("")],vec![text("")],vec![],vec![]);let(mut flows,mut contracts)=(vec![],vec![count as f64]);
 let mut edge_index=std::collections::HashMap::new();
 for i in 0..count{
  let compiled;if !supplied{compiled=crate::save::definitions(s,&arr(vec![forecast.get("flows").array()[i].clone()]),i as f64);}else{compiled=V::Missing;}
  let j=if supplied{&forecast.get("preparedDefinitions").array()[i]}else{&compiled.array()[0]};
  let synthetic;if supplied{synthetic=obj(&[("from",j.get("from").clone()),("to",j.get("to").clone()),("trips",j.get("daily").clone()),("path",obj(&[("fare",j.get("fare").clone()),("km",n(0.0)),("minutes",n(0.0)),("transfers",n(j.get("legs").array().len().saturating_sub(1)as f64)),("edges",arr(vec![]))]))]);}else{synthetic=V::Missing;}
  let f=if supplied{&synthetic}else{&forecast.get("flows").array()[i]};let path=f.get("path");let mut h=vec![0.0;24];h[0]=f.num("from");h[1]=f.num("to");h[2]=match j.get("purpose").text(){"shopping"=>1.0,"leisure"=>2.0,_=>0.0};h[3]=j.get("back").truth()as u8 as f64;h[4]=f.num("trips");h[5]=j.num("daily");h[6]=f.zero("population");h[7]=f.zero("walk");h[8]=f.zero("rail");h[9]=f.zero("road");h[10]=if j.get("hub").truth(){intern(&mut hubs,j.get("hub"))as f64}else{-1.0};h[11]=["visitor-arrival","visitor-return","staff-outbound","staff-homebound","local-departure","local-return"].iter().position(|v|*v==j.get("externalKind").text()).map_or(-1.0,|i|i as f64);h[13]=intern(&mut services,path.get("service"))as f64;h[15]=0.0;h[18]=path.zero("cost");h[19]=path.num("minutes");h[20]=path.num("fare");h[21]=path.num("km");h[22]=path.num("transfers");h[23]=path.get("edges").array().len()as f64;flows.extend(&h);
  let mut origin=f.get("from").clone();for e in path.get("edges").array(){let mut e=e.clone();if !e.get("dir").truth(){let l=crate::legacy::line(s,e.get("service"));let index=l.get("trackIds").array().iter().enumerate().position(|(i,id)|eq(id,e.get("track"))&&((eq(&l.get("stops").array()[i],&origin)&&eq(&l.get("stops").array()[i+1],e.get("to")))||(eq(&l.get("stops").array()[i+1],&origin)&&eq(&l.get("stops").array()[i],e.get("to")))));e.set("dir",n(if index.is_some_and(|i|eq(&l.get("stops").array()[i],&origin)){1.0}else{-1.0}));}origin=e.get("to").clone();intern(&mut services,e.get("service"));let key=crate::diagnostics::json(&e);let ix=*edge_index.entry(key).or_insert_with(||{edges.push(e);edges.len()-1});flows.push(ix as f64);}
  flows.push(j.get("byLine").entries().len()as f64);for(id,share)in j.get("byLine").entries(){flows.extend([intern(&mut lines,&text(id))as f64,share.n()*j.num("fare")]);}
  let mut row=vec![i as f64,j.num("daily"),j.num("fare"),h[2],h[3],h[10],h[11],j.num("from"),j.num("to"),j.get("legs").array().len()as f64];for leg in j.get("legs").array(){row.extend([intern(&mut services,leg.get("service"))as f64,leg.num("dir"),leg.num("from"),leg.num("to")]);}row.push(j.get("lineIds").array().len()as f64);for id in j.get("lineIds").array(){row.push(intern(&mut lines,id)as f64);}row.extend([j.get("byLine").entries().len()as f64,0.0]);for(id,share)in j.get("byLine").entries(){row.extend([intern(&mut lines,&text(id))as f64,share.n()]);}contracts.push(row.len()as f64);contracts.extend(row);
 }
 Some((obj(&[("count",n(count as f64)),("graph",obj(&[("services",arr(services)),("lines",arr(lines)),("edges",arr(edges))])),("hubs",arr(hubs)),("effective",boolean(false))]),flows,contracts))
}
