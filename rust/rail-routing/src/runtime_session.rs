//! Persistent Rust runtime arenas. Pulse control, queue, clock, templates and bank share an owner.
use crate::{editor_support::*, value::Value as V, runtime_seed::{Seed,ECONOMY}};
use std::{collections::{HashMap,VecDeque},rc::Rc};
#[derive(Default)]
struct Arena{
    motion:Option<crate::simulation::MotionState>,queues:Option<crate::queues::Queues>,sampling:Option<crate::simulation::Sampling>,
    bank:Option<crate::engine::Settlement>,feedback:crate::operations::CoverageCache,cycle:Option<crate::cycle::Cycle>,calendar:Option<crate::calendar::Calendar>,
}
struct Checkpoint{token:u64,world:V,saved:V,catalog:u64}
struct Runtime{
    record_lengths:Option<V>,persistence_epoch:u64,import_serial:u64,pending_import:Option<(u64,u64,V)>,import_fence:bool,
    seed:Seed,arena:Arena,token:f64,finance:Vec<f64>,clock:crate::runtime_control::Clock,
    train_ids:HashMap<usize,String>,actual_daily:HashMap<usize,f64>,revision:u64,daily_revision:usize,edit_revision:u64,command_serial:u64,receipts:VecDeque<(u64,String,V)>,undo:Option<Checkpoint>,forecast_work:crate::runtime_business::ForecastWork,published_city:Option<u64>,published_review:Option<u64>,
}
fn key(j:&V)->Rc<str>{crate::journey::key(j)}
impl Runtime{
    fn new(v:&V,id:u64,forecasts:&mut crate::forecast_session::ForecastOwner)->Result<Self,String>{
        let mut world=v.get("world").clone();crate::assets::init(&mut world,&crate::bootstrap::config());
        let start=if has(v,"start"){v.num("start")}else{420.0};if !start.is_finite(){return Err("INVALID_RUNTIME_START".into());}
        let catalog=v.num("catalog")as u64;forecasts.retain(catalog)?;
        let warm=v.get("warm").truth()&&!v.get("saved").truth();
        let mut seed=match Seed::new(world,v.get("saved").clone(),catalog,forecasts,start,warm){Ok(s)=>s,Err(e)=>{forecasts.release_owned(catalog);return Err(e);}};
        if v.get("saved").truth(){let mut validation=seed.runtime.clone();if v.get("saved").get("urbanDefs").truth(){validation.set("hasUrbanDefs",boolean(true));}let valid=crate::save::run(&obj(&[("op",text(if v.get("transfer").truth(){"restoreTransfer"}else{"restore"})),("state",seed.world.clone()),("plan",seed.plan.clone()),("saved",validation),("defs",arr(seed.definitions.clone()))]),&crate::bootstrap::config());if !valid.truth(){forecasts.release_owned(catalog);return Err("INVALID_RUNTIME_CHECKPOINT".into());}}
        if has(v,"forecastView"){seed.runtime.set("forecastView",v.get("forecastView").clone());}
        let token=id as f64;let mut arena=Arena::default();let mut calendar=seed.calendar(token,token,token);arena.motion=Some(seed.motion(token));calendar[5]=seed.blocks.len()as f64;arena.calendar=Some(crate::calendar::Calendar::read(&calendar,&mut arena.sampling));
        let queue=seed.queue(token);crate::queues::install(&queue,&mut arena.motion,&mut arena.queues);arena.queues.as_mut().unwrap().native_owner();
        let keys=seed.definitions.iter().enumerate().map(|(i,j)|(key(j),i)).collect();arena.cycle=Some(crate::cycle::Cycle::owned(token,catalog as f64,seed.definitions.len(),seed.runtime.num("nextId")as usize,[seed.runtime.zero("expectedGenerated"),seed.runtime.zero("arrivalRemainder"),seed.runtime.num("rngState")],seed.runtime.zero("demandCarry"),keys));
        let mut finance=seed.finance(token);crate::engine::read(&finance,&mut arena.bank);arena.bank.as_mut().unwrap().loan_views=seed.world.get("economy").get("loans").array().to_vec();arena.bank.as_mut().unwrap().ledger=seed.world.get("economy").get("ledger").array().to_vec();finance.truncate(16);finance[2]=0.0;
        let train_ids=seed.runtime.get("trains").array().iter().enumerate().map(|(i,t)|(i+1,t.get("id").text().to_string())).collect();let actual_daily=seed.definitions.iter().enumerate().map(|(i,j)|(i,j.num("daily"))).collect();
        // Parsed checkpoint trees are construction inputs. Queues retain the authoritative state.
        seed.definitions.clear();seed.definitions.shrink_to_fit();
        for key in ["queues","outside","transfers","waitSince","outsideSince","stationOccupancy"]{del(&mut seed.runtime,key);}
        for train in seed.runtime.get_mut("trains").array_mut(){del(train,"passengers");}
        let mut runtime=Self{record_lengths:None,persistence_epoch:0,import_serial:0,pending_import:None,import_fence:false,seed,arena,token,finance,clock:crate::runtime_control::Clock::new(),train_ids,actual_daily,revision:0,daily_revision:0,edit_revision:v.get("saved").zero("nativeEditRevision")as u64,command_serial:v.get("saved").zero("nativeCommandSerial")as u64,receipts:VecDeque::new(),undo:None,forecast_work:crate::runtime_business::ForecastWork::default(),published_city:None,published_review:None};
        if warm{
            // Warm passenger queues without charging a second set of startup accounts.
            let economy=runtime.seed.world.get("economy").clone();let operating=runtime.seed.world.get("ridership").get("current").zero("operating");
            if let Err(error)=runtime.advance(30.0,10000,f64::INFINITY,forecasts,true){forecasts.release_owned(catalog);return Err(error);}
            runtime.seed.world.set("economy",economy);if let Some(stats)=runtime.arena.queues.as_mut().and_then(|q|q.finance_stats()){stats.day_operating(operating);}
            let frame=runtime.seed.finance(token);crate::engine::read(&frame,&mut runtime.arena.bank);runtime.arena.bank.as_mut().unwrap().loan_views=runtime.seed.world.get("economy").get("loans").array().to_vec();runtime.arena.bank.as_mut().unwrap().ledger=runtime.seed.world.get("economy").get("ledger").array().to_vec();runtime.finance=frame[..16].to_vec();runtime.finance[2]=0.0;
        }runtime.refresh_feedback();let view=runtime.view(false).get("runtime").clone();if runtime.seed.world.num("routeModel")==9.0{crate::runtime_edit::review(&mut runtime.seed.world,&view,"reviewInit",obj(&[]));}runtime.forecast_work.phases(&runtime.seed.world,runtime.seed.runtime.num("minute"));Ok(runtime)
    }
    fn barrier(&self)->f64{let mut barrier=f64::INFINITY;let world=&self.seed.world;if world.get("urban").truth(){barrier=barrier.min(world.get("urban").num("lastMinute")+360.0-1e-7);}if world.get("operationsReview").truth(){barrier=barrier.min(world.get("operationsReview").num("nextAt")-1e-7);}barrier.min(crate::runtime_business::next_phase(world,self.seed.runtime.num("minute")))}
    fn sync_daily(&mut self,forecasts:&mut crate::forecast_session::ForecastOwner)->Result<(),String>{
        let daily=forecasts.handle(&obj(&[("action",text("dailyPatch")),("id",n(self.seed.catalog as f64)),("after",n(self.daily_revision as f64)),("load",boolean(false))]));if daily.get("error").truth(){return Err(daily.get("error").text().into());}let changes=daily.get("entries").array().iter().map(|row|(row.array()[0].n()as usize,row.array()[1].n())).collect::<Vec<_>>();self.daily_revision=daily.num("revision")as usize;for(i,value)in &changes{let old=self.seed.runtime.get("catalogDaily").array().get(*i).map_or(0.0,V::n);self.seed.runtime.get_mut("catalogDaily").array_mut()[*i]=n(*value);let status=self.seed.runtime.get_mut("demandStatus");status.set("daily",n(status.zero("daily")+*value-old));status.set("activeProfiles",n(status.zero("activeProfiles")+u8::from(*value>0.0)as f64-u8::from(old>0.0)as f64));}crate::simulation::daily_changes(&mut self.arena.sampling,&changes);
        if !changes.is_empty(){let minute=self.seed.runtime.get("minute").clone();self.seed.runtime.get_mut("demandStatus").set("updatedAt",minute);}
        Ok(())
    }
    fn run_slice(&mut self,minutes:f64,max:usize,budget:f64,forecasts:&mut crate::forecast_session::ForecastOwner,warming:bool)->Result<V,String>{
        if !minutes.is_finite()||minutes<0.0||minutes>1e8||max==0||max>10000||budget.is_nan()||budget<0.0{return Err("INVALID_RUNTIME_BUDGET".into());}
        self.sync_daily(forecasts)?;
        let barrier=if warming{f64::INFINITY}else{self.barrier()};let now=self.seed.runtime.num("minute");self.finance[15]=self.seed.world.get("ridership").get("current").zero("operating");let seed=&mut self.seed;let catalog=seed.catalog;let provider=&mut |cycle:&mut crate::cycle::Cycle,queues:&mut crate::queues::Queues,indices:&[usize],needs_keys:bool|{
            if needs_keys{return false;}
            for index in indices{let j=forecasts.handle(&obj(&[("action",text("definition")),("id",n(catalog as f64)),("index",n(*index as f64))]));if j.get("error").truth(){return false;}let data=seed.definition(&j);let service=j.get("legs").array().first().map_or(-1.0,|e|seed.name(e.get("service"))as f64);cycle.install_owned_profile(*index,key(&j),service,data,queues);}cycle.metadata_batch();true
        };
        let result=crate::calendar::run_owned(crate::calendar::Batch{token:self.token,time:now,remaining:minutes,max_steps:max,budget,barrier,finance:&self.finance,trace:false},&mut self.arena.calendar,&mut self.arena.cycle,&[],&mut self.arena.sampling,&mut self.arena.feedback,&mut self.arena.motion,&mut self.arena.queues,&mut self.arena.bank,provider);
        for(_,id)in result.definitions{self.actual_daily.insert(id,0.0);}for(uid,_,ordinal)in &result.spawned{self.train_ids.insert(*uid,format!("T{:04}",ordinal));}
        let elapsed=minutes-result.wire[2];self.seed.runtime.set("minute",n(now+elapsed));let clock=self.arena.calendar.as_ref().unwrap().clock_view();for(k,v)in [("demandCarry",clock.0),("arrivalRemainder",clock.1),("rngState",clock.2),("expectedGenerated",clock.3),("nativeSerial",clock.5 as f64),("nextId",clock.6 as f64),("fleetMinute",(now+elapsed).floor())]{self.seed.runtime.set(k,n(v));}
        if self.seed.world.get("ridership").truth(){self.seed.world.get_mut("ridership").set("lastMinute",n(clock.4));}self.seed.runtime.set("departures",self.arena.calendar.as_ref().unwrap().departures_view(&self.seed.names));
        for(id,fleet)in self.arena.calendar.as_ref().unwrap().fleets(){if let Some(l)=self.seed.plan.get_mut("services").array_mut().iter_mut().find(|l|l.get("id").text()==self.seed.names[id]){l.set("fleet",n(fleet));}}
        self.project_world();self.revision+=u64::from(elapsed>0.0);let reason=result.wire[3]as usize;
        if reason==5{return Err("RUNTIME_CATALOG_METADATA_MISSING".into());}if reason==6{return Err("RUNTIME_STATISTICS_CLOCK".into());}
        self.compact_active(forecasts)?;
        Ok(obj(&[("running",boolean(reason!=2)),("remaining",n(result.wire[2].max(0.0))),("steps",n(result.wire[1])),("consumed",n(elapsed)),("reason",text(match reason{1=>"boundary",2=>"blocked",4=>"time",_=>if result.wire[2]<=1e-8{"complete"}else{"steps"}})),("boundary",boolean((now+elapsed)>=barrier-1e-8)),("events",arr(result.spawned.iter().map(|(uid,_,ordinal)|obj(&[("kind",text("TrainCreated")),("uid",n(*uid as f64)),("ordinal",n(*ordinal as f64))])).collect()))]))
    }
    fn refresh_feedback(&mut self){if self.seed.world.num("routeModel")!=9.0{return;}let now=self.seed.runtime.num("minute");let(_,order)=crate::simulation::continuation(&mut self.arena.motion,now);self.arena.calendar.as_mut().unwrap().refresh_feedback(now,self.arena.queues.as_ref().unwrap(),&order,&mut self.arena.feedback);self.project_world();}
    fn refresh_models(&mut self){
        for(i,dir,d)in &mut self.seed.departures{let l=&self.seed.plan.get("services").array()[*i];*d=self.seed.runtime.get("departures").get(&format!("{}|{}",l.get("id").text(),dir)).clone();}
        let frame=self.seed.calendar(self.token,self.token,self.token);self.arena.calendar=Some(crate::calendar::Calendar::read(&frame,&mut self.arena.sampling));
        let frame=self.seed.finance(self.token);crate::engine::read(&frame,&mut self.arena.bank);let bank=self.arena.bank.as_mut().unwrap();bank.loan_views=self.seed.world.get("economy").get("loans").array().to_vec();bank.ledger=self.seed.world.get("economy").get("ledger").array().to_vec();self.finance=frame[..16].to_vec();self.finance[2]=0.0;
    }
    fn due_business(&mut self)->Result<(),String>{
        let now=self.seed.runtime.num("minute");let mut grew=false;
        if (self.seed.world.get("urban").truth()&&now+1e-7>=self.seed.world.get("urban").num("lastMinute")+360.0)||(self.seed.world.get("operationsReview").truth()&&now+1e-7>=self.seed.world.get("operationsReview").num("nextAt")){self.project_world();}
        while self.seed.world.get("urban").truth()&&now+1e-7>=self.seed.world.get("urban").num("lastMinute")+360.0{crate::runtime_business::city_step(&mut self.seed.world,&V::Missing)?;grew=true;self.forecast_work.dirty=true;}
        if self.seed.world.get("operationsReview").truth()&&now+1e-7>=self.seed.world.get("operationsReview").num("nextAt"){
            let rt=self.view(false).get("runtime").clone();let sampled=crate::runtime_edit::review(&mut self.seed.world,&rt,"reviewSample",obj(&[("force",boolean(false))]));
            if !sampled.truth(){return Err("RUNTIME_REVIEW_CLOCK_STALLED".into());}
        }
        self.forecast_work.phases(&self.seed.world,now);if grew{self.refresh_models();self.refresh_feedback();}Ok(())
    }
    fn advance(&mut self,minutes:f64,max:usize,budget:f64,forecasts:&mut crate::forecast_session::ForecastOwner,warming:bool)->Result<V,String>{
        if warming{return self.run_slice(minutes,max,budget,forecasts,true);}
        if !minutes.is_finite()||minutes<0.0||minutes>1e8||max==0||max>10000||budget.is_nan()||budget<0.0{return Err("INVALID_RUNTIME_BUDGET".into());}
        let started=crate::engine::monotonic();let mut remaining=minutes;let mut steps=0usize;let mut events=vec![];
        let mut batch=obj(&[("running",boolean(true)),("reason",text("complete"))]);
        self.due_business()?;
        while remaining>1e-8&&steps<max{
            let left=budget-(crate::engine::monotonic()-started);if left<=0.0{batch.set("reason",text("time"));break;}
            let next=self.run_slice(remaining,max-steps,left,forecasts,false)?;let before=remaining;remaining=next.num("remaining");steps+=next.num("steps")as usize;events.extend_from_slice(next.get("events").array());let boundary=next.get("boundary").truth();batch=next;
            self.due_business()?;
            if !batch.get("running").truth()||(!boundary&&remaining>1e-8)||before-remaining<1e-9{break;}
        }
        if remaining>1e-8&&steps>=max{batch.set("reason",text("steps"));}else if remaining<=1e-8{batch.set("reason",text("complete"));}
        batch.set("remaining",n(remaining));batch.set("consumed",n(minutes-remaining));batch.set("steps",n(steps as f64));batch.set("boundary",boolean(false));batch.set("events",arr(events));Ok(batch)
    }
    fn publish(&mut self,out:&mut V){
        if !out.get("runtime").truth(){return;}
        for(field,prior)in [("urban",&mut self.published_city),("operationsReview",&mut self.published_review)]{let value=self.seed.world.get(field);if value.truth(){let revision=value.zero("revision")as u64;if *prior!=Some(revision){out.get_mut("worldPatch").set(field,value.clone());if field=="urban"{out.get_mut("runtime").set("businessView",obj(&[("development",crate::urban::development_summary(&self.seed.world))]));}*prior=Some(revision);}}}
    }
    fn diagnostic(&mut self,forecasts:&mut crate::forecast_session::ForecastOwner,op:&str)->V{
        let rt=self.view(false).get("runtime").clone();let started=crate::engine::monotonic();let world=&self.seed.world;
        let result=forecasts.diagnose(self.seed.catalog,&obj(&[("state",world.clone()),("runtime",rt),("op",text(op)),("args",obj(&[])),("forecastView",self.seed.runtime.get("forecastView").clone())]));
        obj(&[("bundle",result),("minute",self.seed.runtime.get("minute").clone()),("revision",n(self.revision as f64)),("editRevision",n(self.edit_revision as f64)),("cityRevision",world.get("urban").get("revision").clone()),("ms",n(crate::engine::monotonic()-started))])
    }
    fn project_world(&mut self){
        let bank=self.arena.bank.as_ref().unwrap();for(i,k)in ECONOMY.iter().enumerate(){self.seed.world.get_mut("economy").set(k,if *k=="blocked"{boolean(bank.economy[i]!=0.0)}else{n(bank.economy[i])});}self.seed.world.get_mut("economy").set("minute",self.seed.runtime.get("minute").clone());self.seed.world.get_mut("economy").set("loans",arr(bank.loan_views.clone()));self.seed.world.get_mut("economy").set("ledger",arr(bank.ledger.clone()));
        if let Some(stats)=self.arena.queues.as_mut().and_then(|q|q.finance_stats()){stats.project_world(self.seed.world.get_mut("ridership"),&self.seed.names);}
        if self.seed.world.num("routeModel")==9.0&&self.seed.world.get("ridership").truth(){self.arena.calendar.as_ref().unwrap().project_feedback(self.seed.world.get_mut("ridership"),&self.seed.names);}
    }
    fn view(&mut self,full:bool)->V{
        self.project_world();let mut runtime=self.arena.queues.as_ref().unwrap().object_view(&self.seed.names,&self.train_ids,full);if full{let mut compact=self.arena.queues.as_ref().unwrap().object_view(&self.seed.names,&self.train_ids,false);runtime.set("nativeView",std::mem::take(compact.get_mut("nativeView")));}for(k,v)in self.seed.runtime.entries(){if !matches!(k.as_str(),"defs"|"urbanDefs"|"nativeView"|"plan"|"storedProfiles"|"nativeEditRevision"|"nativeCommandSerial"|"businessView"|"forecastStatus"|"trains"|"queues"|"outside"|"transfers"|"waitSince"|"outsideSince"|"catalogDaily"|"generated"|"boarded"|"alighted"|"completed"|"cancelled"|"rejected"|"revenue"|"vehicleExpense"|"lineRevenue"|"lineBoarded"|"purposeCompleted"|"stationOccupancy"){runtime.set(k,v.clone());}}
        for train in runtime.get_mut("trains").array_mut(){let uid=train.num("uid")as usize;if let Some(id)=self.train_ids.get(&uid){if let Some(old)=self.seed.runtime.get("trains").array().iter().find(|t|t.get("id").text()==id){for key in ["retiringRun","retiringKey"]{if has(old,key){train.set(key,old.get(key).clone());}}}}}
        if full{for row in runtime.get_mut("defs").array_mut(){row.set("daily",n(self.actual_daily.get(&(row.num("id")as usize)).copied().unwrap_or(0.0)));}}
        crate::simulation::project_owned(&self.arena.motion,&mut runtime,&self.seed.plan,&self.seed.blocks);let mut plan=self.seed.plan.clone();for key in ["economy","ridership"]{plan.set(key,self.seed.world.get(key).clone());}runtime.set("plan",plan);runtime.set("storedProfiles",n(self.actual_daily.len()as f64));runtime.set("forecastStatus",self.forecast_work.status(&self.seed.world,self.edit_revision));runtime.set("nativeEditRevision",n(self.edit_revision as f64));runtime.set("nativeCommandSerial",n(self.command_serial as f64));
        if self.record_lengths.is_none(){self.record_lengths=Some(crate::persistence::world_records(&self.seed.world,&V::Missing));}
        let records=crate::persistence::merge(&[self.seed.runtime.get("personalRecords").clone(),self.record_lengths.as_ref().unwrap().clone(),self.seed.world.get("ridership").get("records").clone(),obj(&[("bestRevenue",self.seed.world.get("economy").get("revenue").clone())])]);
        self.seed.runtime.set("personalRecords",records.clone());runtime.set("personalRecords",records);
        obj(&[("editRevision",n(self.edit_revision as f64)),("revision",n(self.revision as f64)),("worldPatch",obj(&[("economy",self.seed.world.get("economy").clone()),("ridership",self.seed.world.get("ridership").clone())])),("runtime",runtime)])
    }
    fn checkpoint(&mut self,settings:&V,at:&V)->Result<V,String>{
        let saved=self.view(true).get("runtime").clone();
        let value=crate::persistence::pack(self.seed.world.clone(),saved,settings);
        let mut out=crate::persistence::encoded(&value,at)?;
        out.set("personalRecords",value.get("personalRecords").clone());out.set("revision",n(self.revision as f64));out.set("editRevision",n(self.edit_revision as f64));Ok(out)
    }
    fn preview_import(&mut self,v:&V)->Result<V,String>{
        let value=crate::persistence::parse(v.get("text").text())?;self.import_serial+=1;
        let preview=obj(&[("state",value.get("state").clone()),("region",value.get("region").clone()),("speed",value.get("speed").clone()),("runtime",boolean(value.get("runtime").truth())),("token",n(self.import_serial as f64))]);
        self.pending_import=Some((self.import_serial,self.persistence_epoch,value));Ok(obj(&[("preview",preview)]))
    }
    fn prepare_import(&mut self,v:&V,forecasts:&mut crate::forecast_session::ForecastOwner)->Result<V,String>{
        let Some((token,epoch,value))=&self.pending_import else{return Err("RESTORE_NO_PREVIEW".into());};
        if v.num("token")!=*token as f64||*epoch!=self.persistence_epoch{return Err("RESTORE_STALE_PREVIEW".into());}
        let value=value.clone();let world=value.get("state").clone();let catalog=v.num("catalog")as u64;
        let mut candidate=Self::new(&obj(&[("world",world.clone()),("saved",value.get("runtime").clone()),("catalog",n(catalog as f64)),("start",world.get("economy").get("minute").clone()),("warm",boolean(false))]),self.token as u64,forecasts).map_err(|e|format!("RESTORE_{}",e))?;
        let old=crate::json_codec::parse(v.get("previous").text()).unwrap_or(V::Missing);
        let raw=crate::json_codec::parse(v.get("recordsRaw").text()).unwrap_or(V::Missing);
        let records=crate::persistence::merge(&[value.get("personalRecords").clone(),old.get("personalRecords").clone(),raw,if eq(world.get("region"),self.seed.world.get("region")){v.get("personalRecords").clone()}else{V::Missing}]);
        let mut settings=value.clone();settings.set("personalRecords",records);settings.set("playing",boolean(false));
        let encoded=candidate.checkpoint(&settings,v.get("at"));forecasts.release_owned(candidate.seed.catalog);
        let mut out=encoded?;let region=world.get("region").text().to_string();let regions=crate::bootstrap::regions();let cfg=regions.get(&region);
        out.set("saveKey",cfg.get("saveKey").clone());out.set("recordsKey",cfg.get("recordsKey").clone());out.set("token",v.get("token").clone());self.import_fence=true;Ok(out)
    }
    fn transaction_view(&mut self,receipt:&V)->V{let mut out=self.view(false);out.set("worldPatch",self.seed.world.clone());for(k,v)in receipt.entries(){out.set(k,v.clone());}out}
    fn candidate(&mut self,world:V,saved:V,catalog:u64,forecasts:&mut crate::forecast_session::ForecastOwner)->Result<Self,String>{
        Self::new(&obj(&[("world",world),("saved",saved),("catalog",n(catalog as f64)),("start",n(self.seed.runtime.num("minute"))),("warm",boolean(false))]),self.token as u64,forecasts)
    }
    fn replace(&mut self,mut next:Self,forecasts:&mut crate::forecast_session::ForecastOwner){
        next.persistence_epoch=self.persistence_epoch;next.import_serial=self.import_serial;next.pending_import=self.pending_import.take();next.import_fence=self.import_fence;next.clock=self.clock.clone();next.revision=self.revision+1;next.edit_revision=self.edit_revision+1;next.command_serial=self.command_serial;next.receipts=std::mem::take(&mut self.receipts);next.undo=self.undo.take();next.forecast_work=std::mem::take(&mut self.forecast_work);
        forecasts.release_owned(self.seed.catalog);*self=next;
    }
    fn edit(&mut self,v:&V,forecasts:&mut crate::forecast_session::ForecastOwner)->Result<V,String>{
        let action=v.get("action").text();let serial=v.num("commandId");
        if action!="preview"&&(!serial.is_finite()||serial<1.0||serial.fract()!=0.0||serial>9007199254740991.0){return Err("INVALID_COMMAND_ID".into());}
        let fingerprint=crate::diagnostics::json(v);
        if action!="preview"&&(serial as u64)<=self.command_serial{
            if let Some((_,previous,receipt))=self.receipts.iter().find(|(id,_,_)|*id==serial as u64){if *previous!=fingerprint{return Err("COMMAND_ID_REUSED".into());}let receipt=receipt.clone();return Ok(self.transaction_view(&receipt));}
            return Err("COMMAND_RECEIPT_EXPIRED".into());
        }
        if action=="demand"&&has(v,"forecastTicket")&&!self.forecast_work.accepts(v.num("forecastTicket"),&self.seed.world,self.edit_revision){return Err("FORECAST_JOB_STALE".into());}
        if v.num("expectedEditRevision")!=self.edit_revision as f64{return Err("EDIT_REVISION_CONFLICT".into());}
        if action=="preview"&&v.get("command").get("kind").text()=="legacy"{let c=v.get("command");let out=crate::legacy::run(&obj(&[("state",self.seed.world.clone()),("action",c.get("op").clone()),("args",c.get("args").clone())]));if out.get("result").get("error").truth(){return Err(out.get("result").get("error").text().into());}return Ok(obj(&[("result",out.get("result").clone()),("quote",obj(&[("net",out.get("result").get("cost").clone())])),("editRevision",n(self.edit_revision as f64))]));}
        if action=="preview"{self.project_world();let out=crate::assets::run(&obj(&[("state",self.seed.world.clone()),("op",text("transaction")),("command",crate::runtime_business::command(&self.seed.world,v.get("command"))),("commit",boolean(false))]),&crate::bootstrap::config());if out.get("result").get("error").truth(){return Err(out.get("result").get("error").text().into());}return Ok(obj(&[("result",out.get("result").clone()),("quote",out.get("quote").clone()),("editRevision",n(self.edit_revision as f64))]));}
        let saved=self.view(true).get("runtime").clone();let before=self.seed.world.clone();
        let mut world=before.clone();let mut result=obj(&[]);let mut quote=V::Missing;let mut rejected=V::Missing;let mut selected=None;
        let (mut snapshot,catalog)=if action=="undo"{
            let checkpoint=self.undo.as_ref().ok_or("UNDO_EXPIRED")?;
            if checkpoint.token as f64!=v.num("undoToken")||checkpoint.saved.num("minute")!=saved.num("minute"){return Err("UNDO_EXPIRED".into());}
            world=checkpoint.world.clone();(checkpoint.saved.clone(),checkpoint.catalog)
        }else{
            let mark=if action=="command"&&world.get("operationsReview").truth(){crate::runtime_edit::review(&mut world,&saved,"reviewPrepare",obj(&[]))}else{V::Missing};
            if action!="demand"{
                if v.get("command").get("kind").text()=="legacy"{let c=v.get("command");if !matches!(c.get("op").text(),"build"|"through"|"setFare"|"setHeadway"|"step"){return Err("UNSUPPORTED_LEGACY_EDIT".into());}let out=crate::legacy::run(&obj(&[("state",world.clone()),("action",c.get("op").clone()),("args",c.get("args").clone())]));result=out.get("result").clone();if result.get("error").truth(){return Err(result.get("error").text().into());}world=out.get("state").clone();quote=obj(&[("net",n(0.0))]);}else{
                if !matches!(v.get("command").get("kind").text(),"network"|"fleet"|"facility"){return Err("STRUCTURED_COMMAND_REQUIRED".into());}
                let out=crate::assets::run(&obj(&[("state",world.clone()),("op",text("transaction")),("command",crate::runtime_business::command(&self.seed.world,v.get("command"))),("commit",boolean(true)),("accounts",world.get("economy").clone())]),&crate::bootstrap::config());
                result=out.get("result").clone();quote=out.get("quote").clone();
                if result.get("error").truth(){return Err(result.get("error").text().into());}
                if has(&result,"insufficient"){return Err("余额不足，请缩短线路或申请贷款。".into());}
                crate::runtime_edit::apply(&mut world,out.get("patch"));
                }
            }
            let source=if action=="demand"{v.num("catalog")as u64}else{self.seed.catalog};
            let migration=crate::runtime_edit::migrate(&world,&self.seed.plan,saved.clone(),source,action=="demand",forecasts)?;
            selected=Some(migration.catalog);rejected=migration.rejected;
            if action=="command"&&world.get("operationsReview").truth(){crate::runtime_edit::review(&mut world,&migration.saved,"reviewRecord",obj(&[("mark",mark)]));}
            else if world.get("operationsReview").truth(){crate::runtime_edit::review(&mut world,&migration.saved,"reviewReady",obj(&[("minute",migration.saved.get("minute").clone())]));}
            (migration.saved,migration.catalog)
        };
        if action=="demand"&&has(v,"forecastView"){snapshot.set("forecastView",v.get("forecastView").clone());}
        if !crate::save::mass(&snapshot)||!crate::runtime_edit::valid_references(&snapshot){if let Some(id)=selected{forecasts.handle(&obj(&[("action",text("release")),("id",n(id as f64))]));}return Err("RUNTIME_MIGRATION_CONSERVATION".into());}
        let cash=world.get("economy").num("cash");let candidate=self.candidate(world,snapshot,catalog,forecasts);
        // Private tables have no JS lease. The arena pin is their entire lifetime.
        if let Some(id)=selected{forecasts.handle(&obj(&[("action",text("release")),("id",n(id as f64))]));}
        let mut candidate=candidate?;
        if !cash.is_finite()||(candidate.seed.world.get("economy").num("cash")-cash).abs()>0.01{forecasts.release_owned(candidate.seed.catalog);return Err("RUNTIME_MIGRATION_ACCOUNTS".into());}
        for event in rejected.array(){let ids=event.get("journey").get("lineIds").array().iter().map(|id|candidate.seed.name(id)).collect::<Vec<_>>();if let Some(stats)=candidate.arena.queues.as_mut().and_then(|q|q.finance_stats()){stats.event(4,&ids,0.0,&[],event.num("count"),0.0,None,None);}}
        // All fallible staging is over. Checkpoint/catalog ownership moves at this one commit point.
        let checkpoint=if action=="command"&&v.get("undo").truth(){forecasts.retain(self.seed.catalog)?;Some(Checkpoint{token:serial as u64,world:before,saved,catalog:self.seed.catalog})}else{None};
        self.replace(candidate,forecasts);
        if action!="demand"{if let Some(old)=self.undo.take(){forecasts.release_owned(old.catalog);}self.undo=checkpoint;}
        self.forecast_work.dirty=action!="demand";self.forecast_work.phases(&self.seed.world,self.seed.runtime.num("minute"));
        self.command_serial=serial as u64;
        let receipt=obj(&[("result",result),("quote",quote),("undoToken",self.undo.as_ref().map_or(V::Null,|u|n(u.token as f64)))]);
        self.receipts.push_back((serial as u64,fingerprint,receipt.clone()));while self.receipts.len()>128{self.receipts.pop_front();}
        Ok(self.transaction_view(&receipt))
    }
    fn compact_active(&mut self,forecasts:&mut crate::forecast_session::ForecastOwner)->Result<(),String>{
        let now=self.seed.runtime.num("minute");let size=self.actual_daily.len();
        if size<=45000||now-self.seed.runtime.get("lastDefCompact").n()<5.0{return Ok(());}
        let mut saved=self.view(true).get("runtime").clone();crate::migration::compact(&mut saved);saved.set("urbanDefs",saved.get("defs").clone());saved.set("lastDefCompact",n(now));
        let next=self.candidate(self.seed.world.clone(),saved,self.seed.catalog,forecasts)?;let revision=self.edit_revision;self.replace(next,forecasts);self.edit_revision=revision;Ok(())
    }

}
#[derive(Default)]
pub(super) struct RuntimeOwner{next:u64,arenas:HashMap<u64,Runtime>}
impl RuntimeOwner{
    pub(super) fn request(&mut self,v:&V,forecasts:&mut crate::forecast_session::ForecastOwner)->V{
        let result=(||->Result<V,String>{let action=v.get("action").text();if action=="create"{self.next+=1;let mut runtime=Runtime::new(v,self.next,forecasts)?;let rt=runtime.view(false).get("runtime").clone();if runtime.seed.world.get("operationsReview").truth(){crate::runtime_edit::review(&mut runtime.seed.world,&rt,"reviewReady",obj(&[("minute",rt.get("minute").clone())]));}let mut out=runtime.view(true);runtime.publish(&mut out);out.set("id",n(self.next as f64));self.arenas.insert(self.next,runtime);return Ok(out);}
            let id=v.num("id");if !id.is_finite()||id<1.0||id.fract()!=0.0{return Err("INVALID_RUNTIME_HANDLE".into());}let id=id as u64;
            if action=="close"{if let Some(runtime)=self.arenas.remove(&id){forecasts.release_owned(runtime.seed.catalog);if let Some(undo)=runtime.undo{forecasts.release_owned(undo.catalog);}}return Ok(V::Null);}
            let runtime=self.arenas.get_mut(&id).ok_or("RUNTIME_EXPIRED")?;
            if runtime.import_fence{
                if action=="pulse"{let mut out=runtime.view(false);out.set("clock",runtime.clock.status());return Ok(out);}
                if !matches!(action,"importCancel"|"importCommitted"|"query"|"snapshot"|"handoff"|"view"|"diagnose"|"forecastQuery"|"intent"|"resetClock"){return Err("RESTORE_COMMIT_PENDING".into());}
            }
            if matches!(action,"command"|"demand"|"undo"|"setDaily"|"observe"|"syncBank"|"credit"|"daily"|"advanceAll"|"advance"){runtime.persistence_epoch+=1;}
            if action=="pulse"&&v.get("playing").truth(){runtime.persistence_epoch+=1;}
            let mut out=match action{
                "checkpoint"=>runtime.checkpoint(v.get("settings"),v.get("at")),
                "previewImport"=>runtime.preview_import(v),
                "prepareImport"=>runtime.prepare_import(v,forecasts),
                "importCancel"|"importCommitted"=>{if let Some((token,_,_))=&runtime.pending_import{if v.num("token")!=*token as f64{return Err("RESTORE_TOKEN_MISMATCH".into());}}runtime.pending_import=None;runtime.import_fence=action=="importCommitted";Ok(V::Null)},
                "command"|"preview"|"demand"|"undo"=>runtime.edit(v,forecasts),
                "intent"=>{if v.get("reset").truth(){runtime.clock.reset();}runtime.clock.observe(v).map_err(str::to_string)?;Ok(runtime.clock.status())},
                "handoff"=>{let mut view=runtime.view(true);view.set("world",runtime.seed.world.clone());Ok(view)},"snapshot"=>Ok(runtime.view(true)),"view"=>Ok(runtime.view(false)),
                "resetClock"=>{runtime.clock.reset();Ok(runtime.clock.status())},
                "query"=>{runtime.project_world();let q=runtime.arena.queues.as_ref().unwrap();let result=match v.get("query").text(){"storage"=>{let storage=runtime.arena.cycle.as_ref().unwrap().storage();obj(&[("cachedProfiles",n(storage[0]as f64)),("metadataBatches",n(storage[1]as f64)),("preparedDefinitions",n(q.prepared_count()as f64)),("storedDefinitions",n(q.definition_count()as f64)),("hostCommandValues",n(q.host_command_values()as f64))])},"history"=>obj(&[("current",runtime.seed.world.get("ridership").get("current").clone()),("history",runtime.seed.world.get("ridership").get("history").clone())]),"summary"=>q.summary_projection(),"train"=>{let id=runtime.train_ids.iter().find(|(_,name)|name.as_str()==v.get("target").text()).map_or(usize::MAX,|(id,_)|*id);q.train_projection(id)},_=>q.station_projection(&runtime.seed.world,v.num("target")as usize,&runtime.seed.names)};Ok(obj(&[("projection",result)]))},
                "setDaily"=>{let result=forecasts.handle(&obj(&[("action",text("setDaily")),("id",n(runtime.seed.catalog as f64)),("index",v.get("index").clone()),("value",v.get("value").clone())]));if result.get("error").truth(){return Err(result.get("error").text().into());}runtime.sync_daily(forecasts)?;Ok(runtime.view(false))},
                "forecastInvalidate"=>{runtime.forecast_work.dirty=true;Ok(runtime.forecast_work.status(&runtime.seed.world,runtime.edit_revision))},
                "forecastBegin"=>{runtime.project_world();Ok(runtime.forecast_work.begin(&runtime.seed.world,runtime.edit_revision,v.get("blocked").truth()))},
                "forecastFinish"=>Ok(runtime.forecast_work.finish(v.num("ticket"),v.get("success").truth())),
                "diagnose"=>{let op=if v.get("query").text()=="alerts"{"alerts"}else{"diagnose"};Ok(runtime.diagnostic(forecasts,op))},
                "observe"=>{let rt=runtime.view(false).get("runtime").clone();let event=crate::runtime_edit::review(&mut runtime.seed.world,&rt,"reviewObserve",obj(&[("id",v.get("eventId").clone())]));if runtime.forecast_work.ready(){crate::runtime_edit::review(&mut runtime.seed.world,&rt,"reviewReady",obj(&[("minute",rt.get("minute").clone())]));}let mut out=runtime.view(false);out.set("event",event);Ok(out)},
                "forecastQuery"=>{let query=v.get("query").text();if !matches!(query,"summary"|"connections"|"daily"|"definition"|"status"){return Err("UNKNOWN_FORECAST_QUERY".into());}let mut input=obj(&[("action",text(query)),("id",n(runtime.seed.catalog as f64)),("ridership",runtime.seed.world.get("ridership").clone()),("services",runtime.seed.world.get("services").clone()),("stations",v.get("stations").clone()),("index",v.get("index").clone())]);input.set("revision",n(runtime.revision as f64));Ok(obj(&[("projection",forecasts.handle(&input)),("revision",n(runtime.revision as f64)),("editRevision",n(runtime.edit_revision as f64)),("cityRevision",runtime.seed.world.get("urban").get("revision").clone())]))},
                "syncBank"=>{runtime.seed.world.set("economy",v.get("economy").clone());runtime.finance=runtime.seed.finance(runtime.token);crate::engine::read(&runtime.finance,&mut runtime.arena.bank);runtime.arena.bank.as_mut().unwrap().loan_views=runtime.seed.world.get("economy").get("loans").array().to_vec();runtime.arena.bank.as_mut().unwrap().ledger=runtime.seed.world.get("economy").get("ledger").array().to_vec();runtime.finance.truncate(16);runtime.finance[2]=0.0;Ok(V::Null)},
                "credit"=>{
                    runtime.project_world();let e=runtime.seed.world.get("economy").clone();let action=v.num("creditAction");let amount=v.zero("amount");let index=e.get("loans").array().iter().position(|l|eq(l.get("id"),v.get("loanId"))).map_or(-1.0,|i|i as f64);let balance=crate::bootstrap::config();let b=balance.get("balance");let mut input=vec![1.0,6.0,e.num("minute"),amount,index,e.num("nextLoan"),action,0.0,0.0,0.0,0.0,b.num("OPERATING_FACTOR"),b.num("GRANT_RATE"),runtime.seed.runtime.zero("demandCarry")];for key in ECONOMY{input.push(num(e.get(key)));}input.push(e.get("loans").array().len()as f64);for l in e.get("loans").array(){for key in ["principal","interest","installment","nextDue"]{input.push(l.num(key));}}input.push(0.0);let out=crate::operations::run(&input);
                    let mut economy=e.clone();for(i,key)in ECONOMY.iter().enumerate(){economy.set(key,if *key=="blocked"{boolean(out[8+i]!=0.0)}else{n(out[8+i])});}let mut at=18;let mut loans=vec![];for _ in 0..out[17]as usize{let ix=out[at];let mut row=if ix<0.0{obj(&[("id",e.get("nextLoan").clone()),("initial",n(amount))])}else{e.get("loans").array()[ix as usize].clone()};for(i,key)in ["principal","interest","installment","nextDue"].iter().enumerate(){row.set(key,n(out[at+1+i]));}loans.push(row);at+=5;}economy.set("loans",arr(loans));let payments=out[at]as usize;let bills=out[at+1..at+1+payments].to_vec();at+=1+payments;let allocation=out[at]as usize;at+=1+allocation;let error=out[at];let available=out[at+1];let amount=out[at+2];if error==0.0&&action!=0.0{economy.set("nextLoan",n(out[at+3]));let minute=economy.get("minute").clone();economy.get_mut("ledger").array_mut().insert(0,obj(&[("minute",minute),("type",text(if action==1.0{"贷款到账"}else{"提前结清贷款"})),("amount",n(amount))]));}for bill in bills{let minute=economy.get("minute").clone();economy.get_mut("ledger").array_mut().insert(0,obj(&[("minute",minute),("type",text("每日偿还贷款本息")),("amount",n(-bill))]));}economy.get_mut("ledger").array_mut().truncate(80);runtime.seed.world.set("economy",economy);let frame=runtime.seed.finance(runtime.token);crate::engine::read(&frame,&mut runtime.arena.bank);runtime.arena.bank.as_mut().unwrap().loan_views=runtime.seed.world.get("economy").get("loans").array().to_vec();runtime.arena.bank.as_mut().unwrap().ledger=runtime.seed.world.get("economy").get("ledger").array().to_vec();runtime.finance=frame[..16].to_vec();runtime.finance[2]=0.0;if error==0.0&&action!=0.0{runtime.clock.reset();}let mut view=runtime.view(false);view.set("credit",obj(&[("error",n(error)),("available",n(available))]));Ok(view)
                },
                "daily"=>{let out=forecasts.handle(&obj(&[("action",text("setDaily")),("id",n(runtime.seed.catalog as f64)),("index",v.get("index").clone()),("value",v.get("value").clone())]));if out.get("error").truth(){return Err(out.get("error").text().into());}Ok(out)},
                "advanceAll"=>{let requested=v.num("minutes");let mut remaining=requested;let mut steps=0.0;let mut result=obj(&[("running",boolean(true)),("boundary",boolean(false)),("remaining",n(remaining)),("steps",n(0.0))]);while remaining>1e-8{result=runtime.advance(remaining,10000,f64::INFINITY,forecasts,false)?;let left=result.num("remaining");steps+=result.num("steps");if result.get("boundary").truth()||!result.get("running").truth()||left>=remaining-1e-9{remaining=left;break;}remaining=left;}result.set("remaining",n(remaining));result.set("steps",n(steps));result.set("consumed",n(requested-remaining));let mut view=runtime.view(true);view.set("batch",result);Ok(view)},
                "advance"=>{let max=v.num("maxSteps");if !max.is_finite()||max.fract()!=0.0||max<1.0||max>10000.0{return Err("INVALID_RUNTIME_BUDGET".into());}let batch=runtime.advance(v.num("minutes"),max as usize,v.num("budget"),forecasts,false)?;let mut view=runtime.view(false);view.set("batch",batch);Ok(view)},
                "pulse"=>{let start=crate::engine::monotonic();let control=runtime.clock.begin(v).map_err(str::to_string)?;let request=control.get("request");let mut batch=V::Missing;if request.truth(){batch=match runtime.advance(request.num("minutes"),request.num("maxSteps")as usize,request.num("budget"),forecasts,false){Ok(batch)=>batch,Err(error)=>{let _=runtime.clock.fail(&obj(&[("ticket",request.get("ticket").clone()),("fault",text(&error))]));return Err(error);}};runtime.clock.complete(&obj(&[("ticket",request.get("ticket").clone()),("result",batch.clone()),("ms",n(crate::engine::monotonic()-start))])).map_err(str::to_string)?;}let mut view=runtime.view(false);view.set("clock",runtime.clock.status());view.set("batch",batch);Ok(view)},
                _=>Err("UNKNOWN_RUNTIME_ACTION".into())
            }?;runtime.publish(&mut out);Ok(out)
        })();result.unwrap_or_else(|e|obj(&[("error",text(&e))]))
    }
}
#[no_mangle]
pub extern "C" fn runtime_session_abi()->u32{6}
