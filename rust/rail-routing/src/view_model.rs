//! Detached projections for UI panels. No model mutation or RNG consumption.
use crate::{bootstrap::round,editor_support::*,value::Value as V};
const WEIGHTS:[(&str,f64);7]=[("crowding",0.22),("waiting",0.18),("speed",0.15),("coverage",0.15),("fare",0.13),("reliability",0.10),("hours",0.07)];
fn line(s:&V,id:&V)->V{let q=s.get("ridership").get("lines").get(&jsstring(id));if !q.truth(){return obj(&[("awareness",n(1.0)),("trust",n(1.0)),("serviceDays",n(0.0)),("factor",n(1.0)),("bestDay",n(0.0))]);}let mut out=q.clone();let factor=if s.get("ridership").num("model")==22.0{0.25+0.75*fallback(q.get("satisfaction"),0.7).clamp(0.0,1.0)}else{q.num("awareness")*q.num("trust")};out.set("factor",n(factor));out}
fn awards(records:&V)->V{
 let mut rows=vec![];
 let mut add=|id:&str,name:&str,key:&str,target:f64,category:&str,unit:&str,suffix:&str|{let value=records.zero(key);let income=category=="收入";let mut row=obj(&[("id",text(id)),("name",text(name)),("target",n(target)),("value",n(value))]);if matches!(id,"first100"|"day1000"|"day10000"|"hour1000"){row.set("unit",text(unit));row.set("suffix",text(suffix));row.set("category",text(category));}else{row.set("category",text(category));row.set("unit",text(unit));row.set("suffix",text(suffix));}for (key,value) in [("displayTarget",n(if income{target*0.05}else{target})),("displayValue",n(if income{value*0.05}else{value})),("unlocked",boolean(value+1e-7>=target)),("progress",n((value/target).min(1.0)))]{row.set(key,value);}rows.push(row);};
 for(id,name,key,target,unit)in [("first100","初具人气","totalCompleted",100.0,"完成出行"),("day1000","城市通勤","bestDay",1000.0,"单日完成出行"),("day10000","万人线路网","bestDay",10000.0,"单日完成出行"),("hour1000","高峰承运","bestHour",1000.0,"连续60分钟完成出行")]{add(id,name,key,target,"客流",unit,"人次");}
 for(key,category,unit,suffix,tiers)in [
  ("totalCompleted","客流","单局累计完成出行","人次",vec![(1e5,"十万次抵达"),(1e6,"百万旅程")]),
  ("totalPassengerKm","运输","单局累计客运周转量","人公里",vec![(1e4,"穿行城市"),(1e5,"十万人公里"),(1e6,"百万公里同行")]),
  ("bestNetworkKm","线网","最高线网长度","km",vec![(10.0,"初成线网"),(50.0,"城市骨架"),(100.0,"百公里网络"),(500.0,"都市圈动脉")]),
  ("bestLineKm","线网","最长单线长度","km",vec![(10.0,"跨区通勤"),(30.0,"城市走廊"),(50.0,"长线贯城")]),
  ("bestRevenue","收入","单局累计实际票款","元",vec![(2e6,"首个十万票款"),(2e7,"百万票款"),(2e8,"千万票款"),(2e9,"亿元票款")])
 ]{for(i,(target,name))in tiers.iter().enumerate(){add(&format!("{}{}",key,i),name,key,*target,category,unit,suffix);}}
 arr(rows)
}
fn journey_factor(state: &V, journey: &V) -> f64 {
    let ids = if has(journey, "lineIds") {
        journey.get("lineIds").array().to_vec()
    } else {
        journey.get("path").get("fares").entries().iter().map(|(id, _)| text(id)).collect()
    };
    crate::diagnostics::factor(state, &ids, journey.get("hub").truth())
}

fn station_entries(state: &V, flows: &V) -> V {
    let mut counts = std::collections::BTreeMap::<String, [f64; 2]>::new();
    for flow in flows.array() {
        let trips = flow.num("trips") * journey_factor(state, flow);
        counts.entry(jsstring(flow.get("from"))).or_default()[0] += trips;
        counts.entry(jsstring(flow.get("to"))).or_default()[1] += trips;
    }
    V::Object(counts.into_iter().map(|(id, [entered, exited])|
        (id, obj(&[("entry", n(entered)), ("exit", n(exited))]))).collect())
}

pub(super) fn query(v:&V)->V{let s=v.get("state");match v.get("kind").text(){
 "coldAccount"=>{
     let (economy,error,available)=crate::operations::account_command(v.get("economy"),v,0.0,true);
     obj(&[("economy",economy),("error",n(error)),("available",n(available))])
 },
 "lineSettings"=>obj(&[("fareBands",crate::tariffs::bands(v.get("line"))),("patterns",crate::diagnostics::patterns(v.get("line")))]),
 "legacyFleetDuration"=>n(1.0 + crate::legacy::legacy_running_time(v.get("lengths").array().iter().map(num))),
 "distanceFare"=>crate::tariffs::quote(v.get("line"),num(v.get("km"))),
 "feedbackFares"=>arr(crate::tariffs::feedback(v.get("line"),v.num("length")).map(n).to_vec()),
 "defaultPatterns"=>crate::diagnostics::patterns(v.get("line")),
 "patternDraft"=>crate::line_planning::query(s,v).unwrap_or_else(|e|obj(&[("error",text(e))])),
 "currencyTo"=>n(round(v.num("value")*0.05*100.0)/100.0),"currencyFrom"=>n(round(v.num("value")/0.05)),
 "awards"=>awards(v.get("records")),
 "weights"=>V::Object(WEIGHTS.iter().map(|(k,w)|(k.to_string(),n(*w))).collect()),
 "multiplier"=>n(0.25+0.75*v.num("score").clamp(0.0,1.0)),
 "factor"=>n(journey_factor(s,v.get("journey"))),
 "stationEntries"=>station_entries(s,v.get("flows")),
 "station"=>{let current=s.get("ridership").get("current");let mut out=obj(&[("entered",n(0.0)),("boarded",n(0.0)),("alighted",n(0.0))]);if current.num("number")==crate::history::day(v.num("minute")){for(k,val)in current.get("stations").get(&jsstring(v.get("target"))).entries(){out.set(k,val.clone());}}out},
 "limits"=>{let ls=if s.get("baseLines").truth(){s.get("baseLines")}else{s.get("services")};let lines=ls.array().iter().filter(|l|l.get("stops").array().iter().any(|id|eq(id,v.get("target")))).collect::<Vec<_>>();let cars=lines.iter().map(|l|if l.get("cars").truth(){l.num("cars")}else{6.0}).fold(4.0_f64,f64::max);let cfg=crate::bootstrap::config();let length=lines.iter().filter(|l|l.get("fleetManaged").truth()).map(|l|cfg.get("specs").get(l.get("stockSpec").text()).num("length")+20.0).fold(cars*20.0+20.0,f64::max);let platforms=(lines.len()as f64*2.0).clamp(2.0,6.0);let area=length*3.0*platforms;let capacity=(area/0.93).floor();obj(&[("capacity",n(capacity)),("outsideCapacity",n((capacity*0.5).floor())),("platforms",n(platforms)),("length",n(length)),("usableWidth",n(3.0)),("area",n(area)),("spacePerPerson",n(0.93))])},
 "day"=>n(crate::history::day(v.num("minute"))),
 "line"=>{let mut out=line(s,v.get("target"));out.set("weights",V::Object(WEIGHTS.iter().map(|(k,w)|(k.to_string(),n(*w))).collect()));out},
 "finance"=>{let e=s.get("economy");let mut principal=0.0;let loans=e.get("loans").array().iter().map(|l|{let mut row=l.clone();principal+=l.num("principal");let days=((l.num("nextDue")-e.num("minute"))/1440.0).max(0.0);row.set("days",n(days));row.set("nextPayment",n(l.num("principal").min(l.num("installment"))+l.num("interest")+l.num("principal")*0.0005*days));row.set("payoff",n(l.num("principal")+l.num("interest")));row}).collect();obj(&[("principal",n(principal)),("loans",arr(loans))])},
 "center"=>{let rows=v.get("rows").array().iter().filter(|r|!matches!(r.get("satisfaction"),V::Null|V::Missing)).collect::<Vec<_>>();let total=rows.iter().map(|r|r.get("stats").zero("riders").max(0.0)).sum::<f64>();let mut average=0.0;let mut scores=obj(&[]);let mut low=0;let mut high=0;for r in &rows{let weight=if total>0.0{r.get("stats").zero("riders").max(0.0)/total}else{1.0/(rows.len().max(1)as f64)};let satisfaction=r.num("satisfaction");average+=satisfaction*weight;low+=usize::from(satisfaction<0.6);high+=usize::from(satisfaction>=0.85);let l=line(s,r.get("id"));for(k,_)in WEIGHTS{let value=fallback(l.get("scores").get(k),satisfaction);scores.set(k,n(scores.zero(k)+value*weight));}}obj(&[("count",n(rows.len()as f64)),("total",n(total)),("average",n(average)),("scores",scores),("low",n(low as f64)),("high",n(high as f64))])},
 "stations"=>{let mut order=vec![];let mut by=std::collections::HashMap::<usize,Vec<String>>::new();for l in s.get("services").array(){let mut seen=std::collections::HashSet::new();for id in l.get("stops").array(){let id=id.n()as usize;if !seen.insert(id){continue;}if !by.contains_key(&id){order.push(id);}by.entry(id).or_default().push(l.get("name").text().into());}}let mut rows=vec![];let rt=v.get("runtime");let mut total=0.0;let mut busiest=V::Null;for id in order{let key=id.to_string();let waiting=v.get("counts").zero(&key);let entry=rt.get("outside").get(&key);let outside=if matches!(entry.get("total"),V::Number(_)){entry.num("total")}else{entry.entries().iter().map(|(_,v)|v.n()).sum::<f64>()};let capacity=crate::save::limits(s,id,&crate::bootstrap::config()).0;let row=obj(&[("id",n(id as f64)),("name",s.get("nodes").array().get(id).unwrap_or(&V::Missing).get("name").clone()),("waiting",n(waiting)),("capacity",n(capacity)),("outside",n(outside)),("lines",text(&by[&id].join("、"))),("crowded",boolean(waiting/capacity>0.85||outside>0.0))]);if !busiest.truth()||waiting>busiest.num("waiting"){busiest=row.clone();}total+=waiting;rows.push(row);}obj(&[("count",n(rows.len()as f64)),("waiting",n(total)),("busiest",busiest),("rows",arr(rows))])},
 _=>obj(&[("error",text("UNKNOWN_VIEW_MODEL"))])
}}
#[cfg(test)]mod tests{use super::*;
 #[test]fn loan_projection_does_not_charge_accounts(){let state=obj(&[("economy",obj(&[("minute",n(420.0)),("loans",arr(vec![obj(&[("id",n(1.0)),("principal",n(1000.0)),("installment",n(40.0)),("interest",n(10.0)),("nextDue",n(1860.0))])]))]))]);let before=crate::value::write(&state);let out=query(&obj(&[("kind",text("finance")),("state",state.clone())]));assert_eq!(out.num("principal"),1000.0);assert_eq!(out.get("loans").array()[0].num("nextPayment"),50.5);assert_eq!(before,crate::value::write(&state));}
 #[test]fn income_award_uses_saved_units_and_currency_display(){let out=query(&obj(&[("kind",text("awards")),("records",obj(&[("bestRevenue",n(2e6))]))]));let first=out.array().iter().find(|r|r.get("id").text()=="bestRevenue0").unwrap();assert!(first.get("unlocked").truth());assert_eq!(first.num("displayTarget"),100000.0);assert_eq!(first.num("progress"),1.0);}
}
