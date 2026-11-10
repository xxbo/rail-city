//! Persistent Rust runtime arenas. Pulse control, queue, clock, templates and bank share an owner.
use crate::{editor_support::*, value::Value as V, runtime_seed::{Seed,ECONOMY}};
use std::{collections::HashMap,rc::Rc};
#[derive(Default)]
struct Arena{
    motion:Option<crate::simulation::MotionState>,queues:Option<crate::queues::Queues>,sampling:Option<crate::simulation::Sampling>,
    bank:Option<crate::engine::Settlement>,feedback:crate::operations::CoverageCache,cycle:Option<crate::cycle::Cycle>,calendar:Option<crate::calendar::Calendar>,
}
struct Runtime{
    seed:Seed,arena:Arena,token:f64,finance:Vec<f64>,clock:crate::runtime_control::Clock,
    train_ids:HashMap<usize,String>,actual_daily:HashMap<usize,f64>,revision:u64,daily_revision:usize,
}
fn key(j:&V)->Rc<str>{Rc::from(crate::diagnostics::json(&arr(["legs","from","to","purpose","back","hub","externalKind","fare","byLine"].iter().map(|k|j.get(k).clone()).collect())))}
impl Runtime{
    fn new(v:&V,id:u64,forecasts:&mut crate::forecast_session::ForecastOwner)->Result<Self,String>{
        let mut world=v.get("world").clone();crate::assets::init(&mut world,&crate::bootstrap::config());if world.num("routeModel")!=9.0{return Err("SESSION_RUNTIME_REQUIRES_MODERN_MODEL".into());}
        let start=if has(v,"start"){v.num("start")}else{420.0};if !start.is_finite(){return Err("INVALID_RUNTIME_START".into());}
        let catalog=v.num("catalog")as u64;forecasts.retain(catalog)?;
        let warm=v.get("warm").truth()&&!v.get("saved").truth();
        let mut seed=match Seed::new(world,v.get("saved").clone(),catalog,forecasts,start,warm){Ok(s)=>s,Err(e)=>{forecasts.release_owned(catalog);return Err(e);}};
        let token=id as f64;let mut arena=Arena::default();let mut calendar=seed.calendar(token,token,token);arena.motion=Some(seed.motion(token));calendar[5]=seed.blocks.len()as f64;arena.calendar=Some(crate::calendar::Calendar::read(&calendar,&mut arena.sampling));
        let queue=seed.queue(token);crate::queues::install(&queue,&mut arena.motion,&mut arena.queues);
        let keys=seed.definitions.iter().enumerate().map(|(i,j)|(key(j),i)).collect();arena.cycle=Some(crate::cycle::Cycle::owned(token,catalog as f64,seed.definitions.len(),seed.runtime.num("nextId")as usize,[seed.runtime.zero("expectedGenerated"),seed.runtime.zero("arrivalRemainder"),seed.runtime.num("rngState")],seed.runtime.zero("demandCarry"),keys));
        let mut finance=seed.finance(token);crate::engine::read(&finance,&mut arena.bank);arena.bank.as_mut().unwrap().loan_views=seed.world.get("economy").get("loans").array().to_vec();arena.bank.as_mut().unwrap().ledger=seed.world.get("economy").get("ledger").array().to_vec();finance.truncate(16);finance[2]=0.0;
        let train_ids=seed.runtime.get("trains").array().iter().enumerate().map(|(i,t)|(i+1,t.get("id").text().to_string())).collect();let actual_daily=seed.definitions.iter().enumerate().map(|(i,j)|(i,j.num("daily"))).collect();
        let mut runtime=Self{seed,arena,token,finance,clock:crate::runtime_control::Clock::new(),train_ids,actual_daily,revision:0,daily_revision:0};
        if warm{
            // Warm passenger queues without charging a second set of startup accounts.
            let economy=runtime.seed.world.get("economy").clone();let operating=runtime.seed.world.get("ridership").get("current").zero("operating");
            if let Err(error)=runtime.advance(30.0,10000,f64::INFINITY,forecasts,true){forecasts.release_owned(catalog);return Err(error);}
            runtime.seed.world.set("economy",economy);if let Some(stats)=runtime.arena.queues.as_mut().and_then(|q|q.finance_stats()){stats.day_operating(operating);}
            let frame=runtime.seed.finance(token);crate::engine::read(&frame,&mut runtime.arena.bank);runtime.arena.bank.as_mut().unwrap().loan_views=runtime.seed.world.get("economy").get("loans").array().to_vec();runtime.arena.bank.as_mut().unwrap().ledger=runtime.seed.world.get("economy").get("ledger").array().to_vec();runtime.finance=frame[..16].to_vec();runtime.finance[2]=0.0;
        }Ok(runtime)
    }
    fn barrier(&self)->f64{let mut barrier=f64::INFINITY;let world=&self.seed.world;if world.get("urban").truth(){barrier=barrier.min(world.get("urban").num("lastMinute")+360.0-1e-7);}if world.get("operationsReview").truth(){barrier=barrier.min(world.get("operationsReview").num("nextAt")-1e-7);}barrier}
    fn advance(&mut self,minutes:f64,max:usize,budget:f64,forecasts:&mut crate::forecast_session::ForecastOwner,warming:bool)->Result<V,String>{
        if !minutes.is_finite()||minutes<0.0||minutes>1e8||max==0||max>10000||budget.is_nan()||budget<0.0{return Err("INVALID_RUNTIME_BUDGET".into());}
        let daily=forecasts.handle(&obj(&[("action",text("dailyPatch")),("id",n(self.seed.catalog as f64)),("after",n(self.daily_revision as f64)),("load",boolean(false))]));if daily.get("error").truth(){return Err(daily.get("error").text().into());}let changes=daily.get("entries").array().iter().map(|row|(row.array()[0].n()as usize,row.array()[1].n())).collect::<Vec<_>>();self.daily_revision=daily.num("revision")as usize;for(i,value)in &changes{let old=self.seed.runtime.get("catalogDaily").array().get(*i).map_or(0.0,V::n);self.seed.runtime.get_mut("catalogDaily").array_mut()[*i]=n(*value);let status=self.seed.runtime.get_mut("demandStatus");status.set("daily",n(status.zero("daily")+*value-old));status.set("activeProfiles",n(status.zero("activeProfiles")+u8::from(*value>0.0)as f64-u8::from(old>0.0)as f64));}crate::simulation::daily_changes(&mut self.arena.sampling,&changes);
        let barrier=if warming{f64::INFINITY}else{self.barrier()};let now=self.seed.runtime.num("minute");let seed=&mut self.seed;let catalog=seed.catalog;let provider=&mut |cycle:&mut crate::cycle::Cycle,indices:&[usize],needs_keys:bool|{
            if needs_keys{return false;}
            for index in indices{let j=forecasts.handle(&obj(&[("action",text("definition")),("id",n(catalog as f64)),("index",n(*index as f64))]));if j.get("error").truth(){return false;}let data=seed.definition(&j);let service=j.get("legs").array().first().map_or(-1.0,|e|seed.name(e.get("service"))as f64);cycle.install_profile(*index,key(&j),service,data);}true
        };
        let result=crate::calendar::run_owned(crate::calendar::Batch{token:self.token,time:now,remaining:minutes,max_steps:max,budget,barrier,finance:&self.finance,trace:false},&mut self.arena.calendar,&mut self.arena.cycle,&[],&mut self.arena.sampling,&mut self.arena.feedback,&mut self.arena.motion,&mut self.arena.queues,&mut self.arena.bank,provider);
        for(_,id)in result.definitions{self.actual_daily.insert(id,0.0);}for(uid,_,ordinal)in &result.spawned{self.train_ids.insert(*uid,format!("T{:04}",ordinal));}
        let elapsed=minutes-result.wire[2];self.seed.runtime.set("minute",n(now+elapsed));let clock=self.arena.calendar.as_ref().unwrap().clock_view();for(k,v)in [("demandCarry",clock.0),("arrivalRemainder",clock.1),("rngState",clock.2),("expectedGenerated",clock.3),("nativeSerial",clock.5 as f64),("nextId",clock.6 as f64),("fleetMinute",(now+elapsed).floor())]{self.seed.runtime.set(k,n(v));}
        self.seed.world.get_mut("ridership").set("lastMinute",n(clock.4));self.seed.runtime.set("departures",self.arena.calendar.as_ref().unwrap().departures_view(&self.seed.names));
        for(id,fleet)in self.arena.calendar.as_ref().unwrap().fleets(){if let Some(l)=self.seed.plan.get_mut("services").array_mut().iter_mut().find(|l|l.get("id").text()==self.seed.names[id]){l.set("fleet",n(fleet));}}
        self.project_world();self.revision+=u64::from(elapsed>0.0);let reason=result.wire[3]as usize;
        if reason==5{return Err("RUNTIME_CATALOG_METADATA_MISSING".into());}
        Ok(obj(&[("running",boolean(reason!=2)),("remaining",n(result.wire[2].max(0.0))),("steps",n(result.wire[1])),("consumed",n(elapsed)),("reason",text(match reason{1=>"boundary",2=>"blocked",4=>"time",_=>if result.wire[2]<=1e-8{"complete"}else{"steps"}})),("boundary",boolean((now+elapsed)>=barrier-1e-8)),("events",arr(result.spawned.iter().map(|(uid,_,ordinal)|obj(&[("kind",text("TrainCreated")),("uid",n(*uid as f64)),("ordinal",n(*ordinal as f64))])).collect()))]))
    }
    fn project_world(&mut self){
        let bank=self.arena.bank.as_ref().unwrap();for(i,k)in ECONOMY.iter().enumerate(){self.seed.world.get_mut("economy").set(k,if *k=="blocked"{boolean(bank.economy[i]!=0.0)}else{n(bank.economy[i])});}self.seed.world.get_mut("economy").set("loans",arr(bank.loan_views.clone()));self.seed.world.get_mut("economy").set("ledger",arr(bank.ledger.clone()));
        if let Some(stats)=self.arena.queues.as_mut().and_then(|q|q.finance_stats()){stats.project_world(self.seed.world.get_mut("ridership"),&self.seed.names);}
        self.arena.calendar.as_ref().unwrap().project_feedback(self.seed.world.get_mut("ridership"),&self.seed.names);
    }
    fn view(&mut self,full:bool)->V{
        self.project_world();let mut runtime=self.arena.queues.as_ref().unwrap().object_view(&self.seed.names,&self.train_ids,full);for(k,v)in self.seed.runtime.entries(){if !matches!(k.as_str(),"defs"|"trains"|"queues"|"outside"|"transfers"|"waitSince"|"outsideSince"|"catalogDaily"|"generated"|"boarded"|"alighted"|"completed"|"cancelled"|"rejected"|"revenue"|"vehicleExpense"|"lineRevenue"|"lineBoarded"|"purposeCompleted"|"stationOccupancy"){runtime.set(k,v.clone());}}
        for train in runtime.get_mut("trains").array_mut(){let uid=train.num("uid")as usize;if let Some(id)=self.train_ids.get(&uid){if let Some(old)=self.seed.runtime.get("trains").array().iter().find(|t|t.get("id").text()==id){for key in ["retiringRun","retiringKey"]{if has(old,key){train.set(key,old.get(key).clone());}}}}}
        if full{for row in runtime.get_mut("defs").array_mut(){row.set("daily",n(self.actual_daily.get(&(row.num("id")as usize)).copied().unwrap_or(0.0)));}}
        crate::simulation::project_owned(&self.arena.motion,&mut runtime,&self.seed.plan,&self.seed.blocks);runtime.set("plan",self.seed.plan.clone());
        obj(&[("revision",n(self.revision as f64)),("worldPatch",obj(&[("economy",self.seed.world.get("economy").clone()),("ridership",self.seed.world.get("ridership").clone())])),("runtime",runtime)])
    }
}
#[derive(Default)]
pub(super) struct RuntimeOwner{next:u64,arenas:HashMap<u64,Runtime>}
impl RuntimeOwner{
    pub(super) fn request(&mut self,v:&V,forecasts:&mut crate::forecast_session::ForecastOwner)->V{
        let result=(||->Result<V,String>{let action=v.get("action").text();if action=="create"{self.next+=1;let mut runtime=Runtime::new(v,self.next,forecasts)?;let mut out=runtime.view(true);out.set("id",n(self.next as f64));self.arenas.insert(self.next,runtime);return Ok(out);}
            let id=v.num("id");if !id.is_finite()||id<1.0||id.fract()!=0.0{return Err("INVALID_RUNTIME_HANDLE".into());}let id=id as u64;
            if action=="close"{if let Some(runtime)=self.arenas.remove(&id){forecasts.release_owned(runtime.seed.catalog);}return Ok(V::Null);}
            let runtime=self.arenas.get_mut(&id).ok_or("RUNTIME_EXPIRED")?;
            match action{
                "intent"=>{if v.get("reset").truth(){runtime.clock.reset();}runtime.clock.observe(v).map_err(str::to_string)?;Ok(runtime.clock.status())},
                "snapshot"=>Ok(runtime.view(true)),"view"=>Ok(runtime.view(false)),
                "resetClock"=>{runtime.clock.reset();Ok(runtime.clock.status())},
                "syncBoundary"=>{for k in ["urban","operationsReview"]{if has(v.get("world"),k){runtime.seed.world.set(k,v.get("world").get(k).clone());}}for(i,dir,d)in &mut runtime.seed.departures{let line=&runtime.seed.plan.get("services").array()[*i];let key=format!("{}|{}",line.get("id").text(),dir);*d=runtime.seed.runtime.get("departures").get(&key).clone();}
                    let daily=forecasts.handle(&obj(&[("action",text("dailyPatch")),("id",n(runtime.seed.catalog as f64)),("after",n(0.0)),("load",boolean(true))]));let count=runtime.seed.sampling.get("fi").array().len();let mut values=vec![n(0.0);count];for row in daily.get("entries").array(){values[row.array()[0].n()as usize]=row.array()[1].clone();}runtime.seed.runtime.set("catalogDaily",arr(values));
                    let frame=runtime.seed.calendar(runtime.token,runtime.token,runtime.token);runtime.arena.calendar=Some(crate::calendar::Calendar::read(&frame,&mut runtime.arena.sampling));runtime.finance=runtime.seed.finance(runtime.token);crate::engine::read(&runtime.finance,&mut runtime.arena.bank);runtime.arena.bank.as_mut().unwrap().loan_views=runtime.seed.world.get("economy").get("loans").array().to_vec();runtime.arena.bank.as_mut().unwrap().ledger=runtime.seed.world.get("economy").get("ledger").array().to_vec();runtime.finance.truncate(16);runtime.finance[2]=0.0;Ok(runtime.view(false))},
                "syncBank"=>{runtime.seed.world.set("economy",v.get("economy").clone());runtime.finance=runtime.seed.finance(runtime.token);crate::engine::read(&runtime.finance,&mut runtime.arena.bank);runtime.arena.bank.as_mut().unwrap().loan_views=runtime.seed.world.get("economy").get("loans").array().to_vec();runtime.arena.bank.as_mut().unwrap().ledger=runtime.seed.world.get("economy").get("ledger").array().to_vec();runtime.finance.truncate(16);runtime.finance[2]=0.0;Ok(V::Null)},
                "credit"=>{
                    runtime.project_world();let e=runtime.seed.world.get("economy").clone();let action=v.num("creditAction");let amount=v.zero("amount");let index=e.get("loans").array().iter().position(|l|eq(l.get("id"),v.get("loanId"))).map_or(-1.0,|i|i as f64);let balance=crate::bootstrap::config();let b=balance.get("balance");let mut input=vec![1.0,6.0,e.num("minute"),amount,index,e.num("nextLoan"),action,0.0,0.0,0.0,0.0,b.num("OPERATING_FACTOR"),b.num("GRANT_RATE"),runtime.seed.runtime.zero("demandCarry")];for key in ECONOMY{input.push(num(e.get(key)));}input.push(e.get("loans").array().len()as f64);for l in e.get("loans").array(){for key in ["principal","interest","installment","nextDue"]{input.push(l.num(key));}}input.push(0.0);let out=crate::operations::run(&input);
                    let mut economy=e.clone();for(i,key)in ECONOMY.iter().enumerate(){economy.set(key,if *key=="blocked"{boolean(out[8+i]!=0.0)}else{n(out[8+i])});}let mut at=18;let mut loans=vec![];for _ in 0..out[17]as usize{let ix=out[at];let mut row=if ix<0.0{obj(&[("id",e.get("nextLoan").clone()),("initial",n(amount))])}else{e.get("loans").array()[ix as usize].clone()};for(i,key)in ["principal","interest","installment","nextDue"].iter().enumerate(){row.set(key,n(out[at+1+i]));}loans.push(row);at+=5;}economy.set("loans",arr(loans));let payments=out[at]as usize;let bills=out[at+1..at+1+payments].to_vec();at+=1+payments;let allocation=out[at]as usize;at+=1+allocation;let error=out[at];let available=out[at+1];let amount=out[at+2];if error==0.0&&action!=0.0{economy.set("nextLoan",n(out[at+3]));let minute=economy.get("minute").clone();economy.get_mut("ledger").array_mut().insert(0,obj(&[("minute",minute),("type",text(if action==1.0{"贷款到账"}else{"提前结清贷款"})),("amount",n(amount))]));}for bill in bills{let minute=economy.get("minute").clone();economy.get_mut("ledger").array_mut().insert(0,obj(&[("minute",minute),("type",text("每日偿还贷款本息")),("amount",n(-bill))]));}economy.get_mut("ledger").array_mut().truncate(80);runtime.seed.world.set("economy",economy);let frame=runtime.seed.finance(runtime.token);crate::engine::read(&frame,&mut runtime.arena.bank);runtime.arena.bank.as_mut().unwrap().loan_views=runtime.seed.world.get("economy").get("loans").array().to_vec();runtime.arena.bank.as_mut().unwrap().ledger=runtime.seed.world.get("economy").get("ledger").array().to_vec();runtime.finance=frame[..16].to_vec();runtime.finance[2]=0.0;if error==0.0&&action!=0.0{runtime.clock.reset();}let mut view=runtime.view(false);view.set("credit",obj(&[("error",n(error)),("available",n(available))]));Ok(view)
                },
                "daily"=>{let out=forecasts.handle(&obj(&[("action",text("setDaily")),("id",n(runtime.seed.catalog as f64)),("index",v.get("index").clone()),("value",v.get("value").clone())]));if out.get("error").truth(){return Err(out.get("error").text().into());}Ok(out)},
                "advanceAll"=>{let requested=v.num("minutes");let mut remaining=requested;let mut steps=0.0;let mut result=obj(&[("running",boolean(true)),("boundary",boolean(false)),("remaining",n(remaining)),("steps",n(0.0))]);while remaining>1e-8{result=runtime.advance(remaining,10000,f64::INFINITY,forecasts,false)?;let left=result.num("remaining");steps+=result.num("steps");if result.get("boundary").truth()||!result.get("running").truth()||left>=remaining-1e-9{remaining=left;break;}remaining=left;}result.set("remaining",n(remaining));result.set("steps",n(steps));result.set("consumed",n(requested-remaining));let mut view=runtime.view(false);view.set("batch",result);Ok(view)},
                "advance"=>{let max=v.num("maxSteps");if !max.is_finite()||max.fract()!=0.0||max<1.0||max>10000.0{return Err("INVALID_RUNTIME_BUDGET".into());}let batch=runtime.advance(v.num("minutes"),max as usize,v.num("budget"),forecasts,false)?;let mut view=runtime.view(false);view.set("batch",batch);Ok(view)},
                "pulse"=>{let start=crate::engine::monotonic();let control=runtime.clock.begin(v).map_err(str::to_string)?;let request=control.get("request");let mut batch=V::Missing;if request.truth(){batch=match runtime.advance(request.num("minutes"),request.num("maxSteps")as usize,request.num("budget"),forecasts,false){Ok(batch)=>batch,Err(error)=>{let _=runtime.clock.fail(&obj(&[("ticket",request.get("ticket").clone()),("fault",text(&error))]));return Err(error);}};runtime.clock.complete(&obj(&[("ticket",request.get("ticket").clone()),("result",batch.clone()),("ms",n(crate::engine::monotonic()-start))])).map_err(str::to_string)?;}let mut view=runtime.view(false);view.set("clock",runtime.clock.status());view.set("batch",batch);Ok(view)},
                _=>Err("UNKNOWN_RUNTIME_ACTION".into())
            }
        })();result.unwrap_or_else(|e|obj(&[("error",text(&e))]))
    }
}
#[no_mangle]
pub extern "C" fn runtime_session_abi()->u32{1}
