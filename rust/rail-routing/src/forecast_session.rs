//! P3-2: session-owned forecast tables, identities, revisions and bounded projections.
//! UI handles never contain an authoritative contract buffer or writable daily field.
use crate::{editor_support::*, value::{self, Value as V}};
use std::{collections::{BTreeMap, HashMap, VecDeque}, rc::Rc};
const PAGE: usize = 256;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const PURPOSES: [&str; 3] = ["work", "shopping", "leisure"];
const KINDS: [&str; 6] = ["visitor-arrival", "visitor-return", "staff-outbound", "staff-homebound", "local-departure", "local-return"];
fn numbers(v: &V) -> Vec<f64> { v.array().iter().map(V::n).collect() }
fn numeric(v: &[f64]) -> V { arr(v.iter().copied().map(n).collect()) }
fn fault(s: &str) -> V { obj(&[("error", text(s))]) }
fn unsigned(v: &V) -> Option<usize> { if integer(v) && v.n() >= 0.0 && v.n() <= MAX_SAFE as f64 { Some(v.n() as usize) } else { None } }
fn bits(v: &V) -> Vec<u64> { value::write(v).iter().map(|n|n.to_bits()).collect() }
fn named(names: &V, ix: f64) -> V { names.array().get(ix as usize).cloned().unwrap_or(V::Missing) }
fn label(names: &[&str], ix: f64) -> V { names.get(ix as usize).map_or(V::Null, |s|text(s)) }
fn cursor(data: &[f64], at: usize) -> Option<usize> { let x=*data.get(at)?; if x.is_finite() && x>=0.0 && x.fract()==0.0 { Some(x as usize) } else { None } }
fn offsets(data: &[f64], count: usize, contracts: bool) -> Option<Vec<usize>> {
    let mut at=if contracts {1}else{0}; let mut result=Vec::with_capacity(count);
    if contracts && data.first().copied()!=Some(count as f64) {return None;}
    for _ in 0..count {
        if contracts { let size=cursor(data,at)?; at=at.checked_add(1)?; if size<11 {return None;} result.push(at); at=at.checked_add(size)?; }
        else { result.push(at); let edges=cursor(data,at.checked_add(23)?)?; at=at.checked_add(24)?.checked_add(edges)?; let fares=cursor(data,at)?; at=at.checked_add(1)?.checked_add(fares.checked_mul(2)?)?; }
        if at>data.len(){return None;}
    }
    if at==data.len(){Some(result)}else{None}
}
struct Catalog {
    graph: Rc<V>, hubs: Rc<V>, effective: bool,
    flows: Vec<f64>, contracts: Vec<f64>, fp: Vec<usize>, cp: Vec<usize>,
    revision: u64, changed: BTreeMap<usize,u64>,
    views: VecDeque<(bool,usize,Rc<V>)>, summary: Option<(Vec<u64>,Rc<V>)>, diagnostics:Option<Vec<crate::diagnostics::Flow>>,
}
impl Catalog {
    fn load(dto: &V) -> Option<Self> {
        let count=unsigned(dto.get("count"))?; if count>2_000_000{return None;}
        let flows=numbers(dto.get("flowData"));
        let contracts=if matches!(dto.get("contractData"),V::Array(_)){Some(numbers(dto.get("contractData")))}else{None};
        Self::from_tables(dto,flows,contracts)
    }
    fn from_tables(dto:&V,flows:Vec<f64>,supplied:Option<Vec<f64>>)->Option<Self>{
        let count=unsigned(dto.get("count"))?;if count>2_000_000{return None;}
        let fp=offsets(&flows,count,false)?;
        let graph=dto.get("graph"); let edges=graph.get("edges").array();
        let mut descriptors=vec![];
        for e in edges { let service=graph.get("services").array().iter().position(|id|eq(id,e.get("service")))?; descriptors.push([service as f64,e.num("dir"),e.num("to"),e.num("km")]); }
        // Validate references before entering the legacy trusted numeric compiler.
        for &at in &fp { let h=&flows[at..at+24]; if !(0..3).contains(&(h[2] as i32)) || h[2].fract()!=0.0 {return None;}
            for k in 0..h[23] as usize {let ix=cursor(&flows,at+24+k)?;if ix>=edges.len(){return None;}}
        }
        let contracts=supplied.unwrap_or_else(||crate::catalog::compile(count,&descriptors,&flows));
        let cp=offsets(&contracts,count,true)?;
        // Validate variable-sized contract rows and every name index used by projections.
        for &at in &cp { let end=at+contracts[at-1] as usize; let legs=cursor(&contracts,at+9)?;
            let mut p=at.checked_add(10)?.checked_add(legs.checked_mul(4)?)?;
            if p>=end{return None;} let lines=cursor(&contracts,p)?;p=p.checked_add(1+lines)?;
            if p+2>end{return None;} let shares=cursor(&contracts,p)?;p=p.checked_add(2)?.checked_add(shares.checked_mul(2)?)?;
            if p!=end{return None;}
        }
        Some(Self {graph:Rc::new(graph.clone()),hubs:Rc::new(dto.get("hubs").clone()),effective:dto.get("effective").truth(),flows,contracts,fp,cp,revision:0,changed:BTreeMap::new(),views:VecDeque::new(),summary:None,diagnostics:None})
    }
    fn count(&self)->usize{self.fp.len()}
    fn descriptor(&self,id:u64)->V{obj(&[("id",n(id as f64)),("count",n(self.count() as f64)),("revision",n(self.revision as f64))])}
    fn flow(&self,i:usize)->V {
        let at=self.fp[i];let h=&self.flows[at..at+24];let mut p=at+24;
        let edges=(0..h[23] as usize).map(|_|{let e=named(self.graph.get("edges"),self.flows[p]);p+=1;e}).collect();
        let count=self.flows[p] as usize;p+=1;let mut fares=V::Object(vec![]);
        for _ in 0..count {let id=named(self.graph.get("lines"),self.flows[p]);fares.set(id.text(),n(self.flows[p+1]));p+=2;}
        let path=obj(&[("service",named(self.graph.get("services"),h[13])),("dir",n(h[14])),("lastLine",named(self.graph.get("lines"),h[15])),("fareKm",n(h[16])),("board",n(h[17])),("cost",n(h[18])),("minutes",n(h[19])),("fare",n(h[20])),("km",n(h[21])),("edges",arr(edges)),("transfers",n(h[22])),("fares",fares)]);
        let mut out=obj(&[("from",n(h[0])),("to",n(h[1])),("purpose",label(&PURPOSES,h[2])),("back",boolean(h[3]!=0.0)),("trips",n(h[4])),("demandTrips",n(h[5])),("path",path),("population",n(h[6])),("walk",n(h[7])),("rail",n(h[8])),("road",n(h[9])),("hub",if h[10]<0.0{V::Null}else{named(&self.hubs,h[10])}),("externalKind",if h[11]<0.0{V::Null}else{label(&KINDS,h[11])})]);
        if self.effective {out.set("routeOptions",n(h[12]));}out
    }
    fn definition(&self,i:usize)->V {
        let at=self.cp[i];let d=&self.contracts;let h=&d[at..at+10];let mut p=at+10;let mut legs=vec![];
        for _ in 0..h[9] as usize {legs.push(obj(&[("service",named(self.graph.get("services"),d[p])),("dir",n(d[p+1])),("from",n(d[p+2])),("to",n(d[p+3]))]));p+=4;}
        let count=d[p] as usize;p+=1;let line_ids=(0..count).map(|_|{let id=named(self.graph.get("lines"),d[p]);p+=1;id}).collect();
        let count=d[p] as usize;let names=self.graph.get(if d[p+1]!=0.0{"services"}else{"lines"});p+=2;let mut by_line=V::Object(vec![]);
        for _ in 0..count {let id=named(names,d[p]);by_line.set(id.text(),n(d[p+1]));p+=2;}
        obj(&[("id",n(h[0])),("legs",arr(legs)),("daily",n(h[1])),("fare",n(h[2])),("purpose",label(&PURPOSES,h[3])),("back",boolean(h[4]!=0.0)),("hub",if h[5]<0.0{V::Null}else{named(&self.hubs,h[5])}),("externalKind",if h[6]<0.0{V::Null}else{label(&KINDS,h[6])}),("from",n(h[7])),("to",n(h[8])),("lineIds",arr(line_ids)),("byLine",by_line)])
    }
    fn view(&mut self,definition:bool,i:usize)->V {
        if let Some(p)=self.views.iter().position(|(d,k,_)|*d==definition&&*k==i){let entry=self.views.remove(p).unwrap();let out=(*entry.2).clone();self.views.push_back(entry);return out;}
        let out=Rc::new(if definition{self.definition(i)}else{self.flow(i)});
        self.views.push_back((definition,i,out.clone()));while self.views.len()>PAGE{self.views.pop_front();}(*out).clone()
    }
    fn dto(&self)->V{obj(&[("count",n(self.count() as f64)),("flowData",numeric(&self.flows)),("contractData",numeric(&self.contracts)),("graph",(*self.graph).clone()),("hubs",(*self.hubs).clone()),("effective",boolean(self.effective))])}
    fn totals(&self)->V{let(mut daily,mut active,mut valid)=(0.0,0, true);for &at in &self.cp{let d=self.contracts[at+1];let fare=self.contracts[at+2];daily+=d;active+=usize::from(d>0.0);valid&=d.is_finite()&&d>=0.0&&fare.is_finite()&&fare>=0.0&&self.contracts[at+9]>0.0;}obj(&[("daily",n(daily)),("activeProfiles",n(active as f64)),("valid",boolean(valid))])}
    fn summary(&mut self,q:&V)->V{
        let mut rows=vec![];for id in self.graph.get("lines").array(){let l=q.get("lines").get(id.text());rows.push([l.truth() as u8 as f64,if matches!(l.get("satisfaction"),V::Missing|V::Null){0.7}else{l.num("satisfaction")},num(l.get("awareness")),num(l.get("trust"))]);}
        let model=if q.truth(){if q.num("model")==22.0{22.0}else{1.0}}else{0.0};let mut key=vec![f64::to_bits(model)];for row in &rows{key.extend(row.iter().map(|v|v.to_bits()));}if let Some((old,value))=&self.summary{if *old==key{return (**value).clone();}}
        let(mut expected,mut journeys,mut km,mut transfers)=(0.0,0.0,0.0,0.0);let mut stations=BTreeMap::<usize,[f64;2]>::new();
        for &at in &self.fp{let h=&self.flows[at..at+24];let mut p=at+24+h[23] as usize;let mut factor=1.0;let count=self.flows[p] as usize;p+=1;
            for k in 0..count{let id=self.flows[p] as usize;p+=2;let f=crate::simulation::catalog_factor(model,h[10]>=0.0,&rows[id]);factor=if k==0{f}else{min(factor,f)};}
            expected+=h[5]*factor;let trips=h[4]*factor;journeys+=trips;km+=trips*h[21];if h[22]>0.0{transfers+=trips;}stations.entry(h[0] as usize).or_default()[0]+=trips;stations.entry(h[1] as usize).or_default()[1]+=trips;
        }
        let entries=V::Object(stations.into_iter().map(|(id,r)|(id.to_string(),obj(&[("entry",n(r[0])),("exit",n(r[1]))]))).collect());
        let out=obj(&[("expected",n(expected)),("journeys",n(journeys)),("passengerKm",n(km)),("transferTrips",n(transfers)),("entries",entries)]);self.summary=Some((key,Rc::new(out.clone())));out
    }
    fn connections(&self,input:&V)->V{
        let flows=self.fp.iter().map(|&at|{let h=&self.flows[at..at+24];let mut lines=vec![];for k in 0..h[23] as usize{let e=&self.graph.get("edges").array()[self.flows[at+24+k] as usize];for p in e.get("parts").array(){lines.push(p.get("line").clone());}}
            arr(vec![n(h[0]),n(h[1]),label(&PURPOSES,h[2]),boolean(h[3]!=0.0),n(h[5]),n(h[19]+h[7]),if h[10]<0.0{V::Null}else{named(&self.hubs,h[10])},n(h[22]),n(h[12]),if h[11]<0.0{V::Null}else{label(&KINDS,h[11])},arr(lines)])}).collect();
        crate::connections::run(&obj(&[("services",input.get("services").clone()),("stations",input.get("stations").clone()),("flows",arr(flows))]))
    }
    fn sampling(&self)->V {
        let(mut factors,mut profiles,mut fi,mut pi)=(vec![],vec![],vec![],vec![]);let(mut fk,mut pk)=(HashMap::new(),HashMap::new());
        for i in 0..self.count(){let j=self.definition(i);let f=bits(&arr(vec![j.get("lineIds").clone(),boolean(j.get("hub").truth())]));let p=bits(&arr(vec![j.get("purpose").clone(),j.get("back").clone(),j.get("externalKind").clone()]));
            let f=*fk.entry(f).or_insert_with(||{let ix=factors.len();factors.push(j.clone());ix});let p=*pk.entry(p).or_insert_with(||{let ix=profiles.len();profiles.push(j.clone());ix});fi.push(n(f as f64));pi.push(n(p as f64));
        }
        let mut names=vec![];let mut meta=vec![];for j in &factors{let ids=j.get("lineIds").array();meta.push(n(j.get("hub").truth() as u8 as f64));meta.push(n(ids.len() as f64));for id in ids {let ix=names.iter().position(|x|eq(x,id)).unwrap_or_else(||{names.push(id.clone());names.len()-1});meta.push(n(ix as f64));}}
        for j in &profiles {meta.push(n(PURPOSES.iter().position(|s|*s==j.get("purpose").text()).unwrap_or(0) as f64));meta.push(n(j.get("back").truth() as u8 as f64));let kind=j.get("externalKind").text();let code=match kind{""=>0,"staff-homebound"=>1,"staff-outbound"=>2,"local-departure"=>3,"visitor-return"=>4,_=>5};meta.push(n(code as f64));}
        obj(&[("factors",arr(factors)),("profiles",arr(profiles)),("fi",arr(fi)),("pi",arr(pi)),("names",arr(names)),("meta",arr(meta))])
    }
}
struct Job{stamp:Vec<u64>,epoch:u64,background:bool,snapshot:Rc<V>}
struct Live { definitions:Vec<V>, index:HashMap<Vec<u64>,usize> }
fn journey_text(j:&V)->String{crate::diagnostics::json(&arr(["legs","from","to","purpose","back","hub","externalKind","fare","byLine"].iter().map(|k|j.get(k).clone()).collect()))}
fn journey_key(j:&V)->Vec<u64>{journey_text(j).encode_utf16().map(|c|c as u64).collect()}
#[derive(Default)]
pub(super) struct ForecastOwner {
    serial:u64, catalogs:HashMap<u64,Catalog>, live:HashMap<u64,Live>,
    graphs:HashMap<u64,Rc<V>>,
    pins:HashMap<u64,usize>, deferred_release:std::collections::HashSet<u64>,
    epoch:u64, jobs:HashMap<u64,Job>, pending:Option<u64>, dirty:bool,
    service_cache:VecDeque<(Vec<u64>,Vec<f64>)>,
}
impl ForecastOwner {
    pub(super) fn diagnose(&mut self,id:u64,input:&V)->V{
        if input.get("op").text()=="alerts"{return crate::diagnostics::query_owned(input,&V::Missing,&[]);}
        let Some(c)=self.catalogs.get_mut(&id)else{return fault("FORECAST_EXPIRED")};
        let meta=obj(&[("graph",(*c.graph).clone()),("count",n(c.count()as f64)),("compact",boolean(true))]);
        if c.diagnostics.is_none(){c.diagnostics=Some(crate::diagnostics::decode_owned(&meta,&c.flows));}
        crate::diagnostics::query_owned(input,&meta,c.diagnostics.as_ref().unwrap())
    }
    pub(super) fn retain(&mut self,id:u64)->Result<(),String>{if !self.catalogs.contains_key(&id){return Err("FORECAST_EXPIRED".into());}*self.pins.entry(id).or_default()+=1;Ok(())}
    pub(super) fn release_owned(&mut self,id:u64){if let Some(count)=self.pins.get_mut(&id){*count=count.saturating_sub(1);if *count==0{self.pins.remove(&id);if self.deferred_release.remove(&id){self.catalogs.remove(&id);}}}}
    fn next(&mut self)->Option<u64>{if self.serial>=MAX_SAFE{None}else{self.serial+=1;Some(self.serial)}}
    pub(super) fn advance_epoch(&mut self){self.epoch+=1;self.jobs.clear();self.pending=None;self.dirty=false;self.service_cache.clear();}
    pub(super) fn handle_numeric(&mut self,input:&V,data:&[f64])->V {
        let action=input.get("action").text();let dto=input.get("dto");
        if action!="attach"&&action!="attachOutput"{return fault("UNKNOWN_FORECAST_NUMERIC_OPERATION");}
        let Some(count)=unsigned(dto.get("count"))else{return fault("INVALID_FORECAST_CATALOG")};
        if count>2_000_000{return fault("INVALID_FORECAST_CATALOG");}
        let mut at=0;let mut rail_demand=0.0;
        for _ in 0..count{
            let Some(edges)=cursor(data,at+23)else{return fault("INVALID_FORECAST_CATALOG")};
            rail_demand+=data[at+5];
            let Some(p)=at.checked_add(24).and_then(|p|p.checked_add(edges))else{return fault("INVALID_FORECAST_CATALOG")};
            let Some(fares)=cursor(data,p)else{return fault("INVALID_FORECAST_CATALOG")};
            let Some(end)=fares.checked_mul(2).and_then(|n|p.checked_add(1)?.checked_add(n))else{return fault("INVALID_FORECAST_CATALOG")};
            if end>data.len(){return fault("INVALID_FORECAST_CATALOG");}at=end;
        }
        let contracts=if action=="attach"&&input.get("hasContracts").truth(){Some(data[at..].to_vec())}else{None};
        if action=="attach"&&!input.get("hasContracts").truth()&&at!=data.len(){return fault("INVALID_FORECAST_CATALOG");}
        let Some(c)=Catalog::from_tables(dto,data[..at].to_vec(),contracts)else{return fault("INVALID_FORECAST_CATALOG")};
        let Some(id)=self.next()else{return fault("FORECAST_TOKEN_LIMIT")};let mut result=c.descriptor(id);result.set("flowLength",n(at as f64));result.set("railDemand",n(rail_demand));self.catalogs.insert(id,c);result
    }
    pub(super) fn handle(&mut self,input:&V)->V {
        let op=input.get("action").text();
        if op=="cityIdentity"{return self.next().map_or_else(||fault("FORECAST_TOKEN_LIMIT"),|id|n(id as f64));}
        if op=="journeyKey"{return text(&journey_text(input.get("journey")));}
        if op=="graphFrame"{let frame=graph_frame(input);if frame.get("error").truth(){return frame;}let Some(id)=self.next()else{return fault("FORECAST_TOKEN_LIMIT")};let mut out=frame.clone();out.set("id",n(id as f64));self.graphs.insert(id,Rc::new(frame));return out;}
        if op=="snapshot"{return snapshot(input.get("state"));}
        if op=="serviceFrame"||op=="serviceCompile"{return self.services(input,op=="serviceCompile");}
        if op=="invalidate"{self.dirty=true;return boolean(true);}
        if op=="jobStatus"{return obj(&[("pending",boolean(self.pending.is_some())),("dirty",boolean(self.dirty))]);}
        if op=="begin" {
            let background=input.get("background").truth();if background&&self.pending.is_some(){self.dirty=true;return obj(&[("busy",boolean(true))]);}
            let Some(id)=self.next()else{return fault("FORECAST_TOKEN_LIMIT")};
            let snapshot=Rc::new(snapshot(input.get("state")));let projection=(*snapshot).clone();
            self.jobs.insert(id,Job{stamp:bits(input.get("stamp")),epoch:self.epoch,background,snapshot});if background{self.pending=Some(id);self.dirty=false;}
            return obj(&[("ticket",n(id as f64)),("snapshot",projection)]);
        }
        if op=="jobSnapshot"{let Some(id)=unsigned(input.get("ticket"))else{return fault("INVALID_FORECAST_TICKET")};return self.jobs.get(&(id as u64)).map_or_else(||fault("FORECAST_JOB_EXPIRED"),|job|(*job.snapshot).clone());}
        if op=="accept"||op=="finish" {
            let Some(id)=unsigned(input.get("ticket")).map(|v|v as u64)else{return fault("INVALID_FORECAST_TICKET")};
            let Some(job)=self.jobs.get(&id)else{return obj(&[("accepted",boolean(false))]);};
            let accepted=job.epoch==self.epoch&&job.stamp==bits(input.get("stamp"))&&!input.get("busy").truth();
            if op=="accept"{if !accepted&&job.background{self.dirty=true;}return obj(&[("accepted",boolean(accepted))]);}
            self.jobs.remove(&id);if self.pending==Some(id){self.pending=None;}return obj(&[("dirty",boolean(self.dirty))]);
        }
        if op=="attach" {
            let Some(c)=Catalog::load(input.get("dto"))else{return fault("INVALID_FORECAST_CATALOG")};let Some(id)=self.next()else{return fault("FORECAST_TOKEN_LIMIT")};let out=c.descriptor(id);self.catalogs.insert(id,c);return out;
        }
        if op=="liveBind" {
            let definitions=input.get("definitions").array().to_vec();let index=definitions.iter().enumerate().map(|(i,j)|(journey_key(j),i)).collect();let Some(id)=self.next()else{return fault("FORECAST_TOKEN_LIMIT")};self.live.insert(id,Live{definitions,index});return n(id as f64);
        }
        let Some(id)=unsigned(input.get("id")).map(|x|x as u64)else{return fault("INVALID_FORECAST_HANDLE")};
        if op=="release"{if self.pins.get(&id).copied().unwrap_or(0)>0{self.deferred_release.insert(id);return boolean(true);}self.catalogs.remove(&id);self.live.remove(&id);self.graphs.remove(&id);return boolean(true);}
        if op=="graphPrices"{let Some(g)=self.graphs.get(&id)else{return fault("GRAPH_EXPIRED")};return graph_prices(input.get("state"),g.get("lines"));}
        if op=="materialize"{
            let Some(live)=self.live.get_mut(&id)else{return fault("LIVE_CATALOG_EXPIRED")};let j=input.get("journey");let key=journey_key(j);if let Some(&ix)=live.index.get(&key){return obj(&[("index",n(ix as f64)),("created",boolean(false))]);}
            let ix=live.definitions.len();let mut row=j.clone();row.set("id",n(ix as f64));row.set("daily",n(0.0));live.definitions.push(row.clone());live.index.insert(key,ix);return obj(&[("index",n(ix as f64)),("created",boolean(true)),("definition",row)]);
        }
        if op=="select" {
            let Some(source)=self.catalogs.get(&id)else{return fault("FORECAST_EXPIRED")};let mut flows=vec![];let mut contracts=vec![input.get("indices").array().len() as f64];
            for ix in input.get("indices").array(){let Some(i)=unsigned(ix).filter(|i|*i<source.count())else{return fault("INVALID_CATALOG_INDEX")};let a=source.fp[i];let b=source.fp.get(i+1).copied().unwrap_or(source.flows.len());flows.extend_from_slice(&source.flows[a..b]);let a=source.cp[i];let size=source.contracts[a-1] as usize;contracts.push(size as f64);contracts.extend_from_slice(&source.contracts[a..a+size]);}
            let c=Catalog{graph:source.graph.clone(),hubs:source.hubs.clone(),effective:source.effective,fp:offsets(&flows,contracts[0] as usize,false).unwrap(),cp:offsets(&contracts,contracts[0] as usize,true).unwrap(),flows,contracts,revision:0,changed:BTreeMap::new(),views:VecDeque::new(),summary:None,diagnostics:None};
            let Some(id)=self.next()else{return fault("FORECAST_TOKEN_LIMIT")};let out=c.descriptor(id);self.catalogs.insert(id,c);return out;
        }
        let Some(c)=self.catalogs.get_mut(&id)else{return fault("FORECAST_EXPIRED")};
        match op {
            "export"=>c.dto(),
            "summary"=>c.summary(input.get("ridership")),
            "connections"=>c.connections(input),
            "sampling"=>c.sampling(),
            "totals"=>c.totals(),
            "runtimeGraph"=>(*c.graph).clone(),
            "diagnostic"=>obj(&[("graph",(*c.graph).clone()),("count",n(c.count() as f64)),("flowData",numeric(&c.flows))]),
            "status"=>obj(&[("count",n(c.count() as f64)),("bytes",n(((c.flows.len()+c.contracts.len())*8) as f64)),("revision",n(c.revision as f64)),("retainedFlowViews",n(c.views.iter().filter(|x|!x.0).count() as f64)),("retainedContractViews",n(c.views.iter().filter(|x|x.0).count() as f64)),("limit",n(PAGE as f64))]),
            "dailyPatch"=>{let Some(after)=unsigned(input.get("after"))else{return fault("INVALID_DEMAND_REVISION")};let load=input.get("load").truth();let rows=(0..c.count()).filter(|i|load||c.changed.get(i).is_some_and(|r|*r>after as u64)).map(|i|arr(vec![n(i as f64),n(c.contracts[c.cp[i]+1])])).collect();obj(&[("revision",n(c.revision as f64)),("entries",arr(rows))])},
            "setDaily"=>{let Some(i)=unsigned(input.get("index")).filter(|i|*i<c.count())else{return fault("INVALID_CATALOG_INDEX")};let v=input.get("value");if !finite(v)||v.n()<0.0{return fault("INVALID_DAILY_DEMAND");}let at=c.cp[i]+1;if c.contracts[at].to_bits()!=v.n().to_bits(){if c.revision>=MAX_SAFE{return fault("DEMAND_REVISION_LIMIT");}c.revision+=1;c.contracts[at]=v.n();c.changed.insert(i,c.revision);c.views.retain(|(d,k,_)|!*d||*k!=i);}n(c.revision as f64)},
            "daily"=>{let Some(i)=unsigned(input.get("index")).filter(|i|*i<c.count())else{return fault("INVALID_CATALOG_INDEX")};n(c.contracts[c.cp[i]+1])},
            "page"=>{let Some(start)=unsigned(input.get("start"))else{return fault("INVALID_CATALOG_PAGE")};let count=unsigned(input.get("count")).unwrap_or(PAGE).min(PAGE);let definition=input.get("view").text()!="flow";let end=start.saturating_add(count).min(c.count());arr((start..end).map(|i|c.view(definition,i)).collect())},
            "flow"|"definition"|"profile"|"legs"=>{let Some(i)=unsigned(input.get("index")).filter(|i|*i<c.count())else{return fault("INVALID_CATALOG_INDEX")};if op=="flow"{c.view(false,i)}else{let j=c.view(true,i);if op=="legs"{j.get("legs").clone()}else if op=="profile"{obj(&[("lineIds",j.get("lineIds").clone()),("hub",j.get("hub").clone()),("purpose",j.get("purpose").clone()),("back",j.get("back").clone()),("externalKind",j.get("externalKind").clone())])}else{j}}},
            _=>fault("UNKNOWN_FORECAST_OPERATION"),
        }
    }
    fn services(&mut self,input:&V,compile:bool)->V {
        let mut state=input.get("state").clone();let line=input.get("line");let single=line.truth();let mut source=0;
        let targets=state.get("services").array().to_vec();
        if single{if let Some(i)=unsigned(input.get("sourceIndex")).filter(|i|*i<targets.len()){source=i;}else{source=targets.len();state.get_mut("services").array_mut().push(line.clone());}}
        let minute=input.num("minute");let minute=if compile{if crate::temporal::peak(minute){480.0}else{600.0}}else{minute};
        let (mut frame,tracks)=crate::editor_support::service_frame_with_targets(&state,minute,input.get("strict").truth(),&targets);
        if single{frame[1]=1.0;frame[3]=source as f64;frame[4]=match input.get("index"){V::Number(v)=>*v,V::String(s)=>s.parse::<f64>().ok().filter(|n|n.to_string()==*s).unwrap_or(f64::NAN),_=>f64::NAN};frame.extend(crate::editor_support::pattern_values(input.get("pattern"),&targets,input.get("strict").truth()));}
        let mut out=obj(&[("input",numeric(&frame)),("trackNames",arr(tracks)),("sources",state.get("services").clone())]);
        if compile{let key=frame.iter().map(|n|n.to_bits()).collect::<Vec<_>>();let data=if let Some(i)=self.service_cache.iter().position(|(k,_)|*k==key){let item=self.service_cache.remove(i).unwrap();let data=item.1.clone();self.service_cache.push_front(item);data}else{let data=crate::services::run(&frame);self.service_cache.push_front((key,data.clone()));self.service_cache.truncate(2);data};out.set("data",numeric(&data));}out
    }
}
pub(super) fn snapshot(state:&V)->V {
    let mut result=state.clone();for k in ["ridership","economy","operationsReview","log"]{del(&mut result,k);}
    let e=state.get("economy");result.set("economy",if e.truth(){obj(&[("minute",e.get("minute").clone())])}else{V::Missing});
    let q=state.get("ridership");result.set("ridership",if q.truth(){obj(&[("version",q.get("version").clone()),("model",q.get("model").clone()),("lines",q.get("lines").clone())])}else{V::Missing});result
}

fn graph_prices(state:&V,lines:&V)->V{
    let mut values=vec![];let defaults=[180.0,210.0,260.0,300.0,330.0,400.0];
    for id in lines.array(){let source=state.get("services").array().iter().find(|s|eq(s.get("id"),id));for i in 0..6{let value=if let Some(source)=source{if source.get("fareBands").truth(){source.get("fareBands").array().get(i).map_or(f64::NAN,V::n)}else{defaults[i]}}else{defaults[i]};if !value.is_finite(){return fault("INVALID_ROUTING_NUMBER");}values.push(n(value));}}
    for c in state.get("companies").array(){let value=if matches!(c.get("fare"),V::Missing){0.0}else{c.num("fare")};if !value.is_finite(){return fault("INVALID_ROUTING_NUMBER");}values.push(n(value));}arr(values)
}
fn graph_frame(input:&V)->V{
    fn intern(names:&mut Vec<V>,value:&V)->usize{if let Some(i)=names.iter().position(|n|same(n,value)){i}else{names.push(value.clone());names.len()-1}}
    let state=input.get("state");let adj=input.get("adjacency").array();let mut services=vec![text("")];let mut lines=vec![text("")];let mut groups=vec![];let mut edges=vec![];let mut records=vec![];let mut parts=vec![];
    for line in state.get("services").array(){intern(&mut lines,line.get("id"));}
    for (from,row) in adj.iter().enumerate(){for edge in row.array(){let service=intern(&mut services,edge.get("service"));let dir=if edge.get("dir").truth(){edge.num("dir")}else{0.0};let key=format!("{}|{}",edge.get("service").text(),dir);let group=groups.iter().position(|g:&String|*g==key).unwrap_or_else(||{groups.push(key);groups.len()-1});let start=parts.len()/2;
        for part in edge.get("parts").array(){if !finite(part.get("km")){return fault("INVALID_ROUTING_NUMBER");}parts.push(intern(&mut lines,part.get("line")) as f64);parts.push(part.num("km"));}
        let owner=state.get("companies").array().iter().position(|c|eq(c.get("id"),edge.get("owner"))).unwrap_or(31);
        for key in ["km","minutes","headway"]{if !finite(edge.get(key)){return fault("INVALID_ROUTING_NUMBER");}}
        let fare=if matches!(edge.get("fare"),V::Missing){0.0}else{edge.num("fare")};let penalty=if matches!(edge.get("penalty"),V::Missing){0.0}else{edge.num("penalty")};if !fare.is_finite()||!penalty.is_finite(){return fault("INVALID_ROUTING_NUMBER");}
        records.extend([from as f64,edge.num("to"),service as f64,dir,0.0,edge.num("km"),edge.num("minutes"),edge.num("headway"),group as f64,start as f64,(parts.len()/2-start) as f64,owner as f64,fare,penalty,edge.get("through").truth() as u8 as f64]);edges.push(edge.clone());
    }}
    let mut data=vec![1.0,input.get("legacy").truth() as u8 as f64,adj.len() as f64,lines.len() as f64,edges.len() as f64,(parts.len()/2) as f64,state.get("companies").array().len() as f64];data.extend(records);data.extend(parts);
    obj(&[("data",numeric(&data)),("services",arr(services)),("lines",arr(lines)),("groups",arr(groups.iter().enumerate().map(|(i,g)|arr(vec![text(g),n(i as f64)])).collect())),("edges",arr(edges)),("legacy",boolean(input.get("legacy").truth()))])
}

#[no_mangle]
pub extern "C" fn forecast_session_abi()->u32{1}
