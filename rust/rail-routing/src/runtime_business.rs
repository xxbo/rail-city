//! City/observation due work and prediction lineage belong to the runtime owner.
use crate::{editor_support::*,value::Value as V};
use std::collections::HashSet;
#[derive(Default)]
pub(super) struct ForecastWork{
    serial:u64,pending:Option<(u64,[u64;4])>,pub dirty:bool,
    period:Option<Vec<u64>>,phase:u64,
}
impl ForecastWork{
    pub fn stamp(&self,world:&V,edit:u64)->[u64;4]{[edit,world.get("urban").zero("revision")as u64,world.get("urban").zero("step")as u64,self.phase]}
    pub fn phases(&mut self,world:&V,minute:f64){
        let clock=minute.rem_euclid(1440.0);let mut current=vec![crate::temporal::peak(minute)as u64];
        for l in world.get("services").array(){let open=l.num("open");let close=l.num("close");let active=if open<=close{clock>=open&&clock<close}else{clock>=open||clock<close};current.extend([planned(l,minute).to_bits(),active as u64]);}
        if self.period.as_ref().is_some_and(|old|*old!=current){self.phase+=1;self.dirty=true;}self.period=Some(current);
    }
    pub fn status(&self,world:&V,edit:u64)->V{obj(&[("dirty",boolean(self.dirty)),("busy",boolean(self.pending.is_some())),("stamp",arr(self.stamp(world,edit).iter().map(|n|crate::editor_support::n(*n as f64)).collect()))])}
    pub fn begin(&mut self,world:&V,edit:u64,blocked:bool)->V{
        if self.pending.is_some(){return obj(&[("busy",boolean(true))]);}if !self.dirty||blocked{return obj(&[("needed",boolean(false))]);}
        self.serial+=1;let stamp=self.stamp(world,edit);self.pending=Some((self.serial,stamp));self.dirty=false;
        obj(&[("needed",boolean(true)),("ticket",n(self.serial as f64)),("expectedEditRevision",n(edit as f64)),("snapshot",crate::forecast_session::snapshot(world))])
    }
    pub fn ready(&self)->bool{!self.dirty&&self.pending.is_none()}
    pub fn accepts(&self,ticket:f64,world:&V,edit:u64)->bool{self.pending.is_some_and(|(id,stamp)|id as f64==ticket&&stamp==self.stamp(world,edit))}
    pub fn finish(&mut self,ticket:f64,success:bool)->V{if self.pending.is_some_and(|(id,_)|id as f64==ticket){self.pending=None;if !success{self.dirty=true;}}obj(&[("dirty",boolean(self.dirty)),("busy",boolean(self.pending.is_some()))])}
}
pub(super) fn city_step(world:&mut V,source:&V)->Result<f64,String>{
    let first=crate::bootstrap::urban_call(0,world,vec![]);for(k,v)in first.get("urban").entries(){world.get_mut("urban").set(k,v.clone());}
    let mut keys=world.get("urban").get("cells").entries().iter().map(|(k,_)|k.clone()).collect::<Vec<_>>();let mut seen=keys.iter().cloned().collect::<HashSet<_>>();
    for p in first.get("points").array(){if crate::bootstrap::buildable_input(world,p,source){let key=format!("{}:{}",(p.num("x")/12.0).floor(),(p.num("y")/12.0).floor());if seen.insert(key.clone()){keys.push(key);}}}keys.truncate(24000);
    let metadata=if matches!(source,V::Missing){crate::bootstrap::city(world.get("region").text()).get("metadata").clone()}else{source.get("metadata").clone()};let old=world.get("urban").num("lastMinute");
    let result=crate::bootstrap::urban_call(1,world,vec![("keys",arr(keys.iter().map(|k|text(k)).collect())),("metadata",metadata)]);
    if result.get("urban").num("lastMinute")<=old{return Err("URBAN_CLOCK_STALLED".into());}world.set("urban",result.get("urban").clone());Ok(result.num("growth"))
}

pub(super) fn next_phase(world:&V,minute:f64)->f64{
    let mut next=f64::INFINITY;let day=(minute/1440.0).floor()*1440.0;
    for offset in [420.0,540.0,1020.0,1140.0].into_iter().chain(world.get("services").array().iter().flat_map(|l|[l.num("open"),l.num("close")])){if !offset.is_finite(){continue;}let mut at=day+offset;if at<=minute+1e-7{at+=1440.0;}next=next.min(at);}
    next
}

pub(super) fn command(world:&V,command:&V)->V{
    let mut out=command.clone();if command.get("kind").text()=="facility"&&command.get("op").text()=="plan"{out.get_mut("args").set("land",boolean(crate::bootstrap::buildable(world,command.get("args").get("point"))));}out
}

pub(super) fn enable_automatic(world:&mut V,source:&V,places:&V)->bool{
 if world.get("urban").get("facilityMode").text()=="automatic"{return false;}
 if !world.get("urban").truth(){let u=crate::bootstrap::run(&obj(&[("op",text("urbanInit")),("state",world.clone())]));world.set("urban",u);}
 let transfer=crate::assets::run(&obj(&[("op",text("municipalTransfer")),("state",world.clone()),("args",obj(&[]))]),&crate::bootstrap::config());crate::runtime_edit::apply(world,transfer.get("patch"));
 let native=crate::bootstrap::city(world.get("region").text());let base=if matches!(source,V::Missing){&*native}else{source};let mut candidates=if !places.array().is_empty(){places.array().to_vec()}else{let mut rows=base.get("cells").array().iter().filter(|c|c.num("people")>100.0).cloned().collect::<Vec<_>>();rows.sort_by(|a,b|b.num("people").total_cmp(&a.num("people")));rows};let hubs=crate::bootstrap::hubs(world.get("region").text());
 candidates.retain(|p|crate::bootstrap::buildable_input(world,p,source)&&!hubs.array().iter().any(|h|crate::legacy::distance(h,p)<0.25));let projected=arr(candidates.iter().map(|p|obj(&[("x",p.get("x").clone()),("y",p.get("y").clone()),("name",if p.get("name").truth(){p.get("name").clone()}else{text("城市片区")})])).collect());let anchors=crate::bootstrap::urban_call(11,world,vec![("places",projected)]);let u=world.get_mut("urban");u.set("autoCandidates",anchors);u.set("facilityMode",text("automatic"));u.set("revision",n(u.zero("revision")+1.0));let facilities=crate::bootstrap::urban_call(4,world,vec![]);for(k,v)in facilities.entries(){world.get_mut("urban").set(k,v.clone());}true
}
pub(super) fn enable_development(world:&mut V,source:&V,places:&V)->bool{
 if !world.get("urban").truth()||world.get("urban").get("development").truth(){return false;}let filtered=arr(places.array().iter().filter(|p|crate::bootstrap::buildable_input(world,p,source)).cloned().collect());let d=crate::bootstrap::urban_call(10,world,vec![("region",world.get("region").clone()),("places",filtered)]);let u=world.get_mut("urban");u.set("development",d);u.set("revision",n(u.zero("revision")+1.0));true
}
pub(super) fn candidates(world:&V,source:&V)->V{let mut keys=world.get("urban").get("cells").entries().iter().map(|(k,_)|k.clone()).collect::<Vec<_>>();let mut seen=keys.iter().cloned().collect::<HashSet<_>>();for p in crate::bootstrap::urban_call(12,world,vec![]).array(){if crate::bootstrap::buildable_input(world,p,source){let key=format!("{}:{}",(p.num("x")/12.0).floor(),(p.num("y")/12.0).floor());if seen.insert(key.clone()){keys.push(key);}}}keys.truncate(24000);arr(keys.iter().map(|k|text(k)).collect())}
