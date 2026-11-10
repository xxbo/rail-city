//! Session-owned elapsed time, debt, cancellation and bounded transaction scheduling.
//! Platform callers supply observations; no JS time-step selection or debt mutation.
use crate::{editor_support::*, value::Value as V};
use std::collections::HashMap;
const EPS:f64=1e-8;
#[derive(Default)]
pub(super) struct Clock {
    epoch:u64, serial:u64, pending:f64, active:Option<(u64,u64,f64)>,
    last_at:Option<f64>, playing:bool, visible:bool, running:bool, elapsed_ms:f64,fault:Option<V>,
}
impl Clock {
    pub(super) fn new()->Self{Self{visible:true,running:true,..Self::default()}}
    pub(super) fn reset(&mut self){self.epoch+=1;self.pending=0.0;self.last_at=None;self.running=true;self.fault=None;}
    pub(super) fn observe(&mut self,input:&V)->Result<(),&'static str>{
        let speed=input.num("speed");if !speed.is_finite()||speed<0.0{return Err("INVALID_SIMULATION_SPEED");}
        let visible=if has(input,"visible"){input.get("visible").truth()}else{true};
        let playing=if has(input,"playing"){input.get("playing").truth()}else{true};
        if has(input,"at"){
            let at=input.num("at");if !at.is_finite(){return Err("INVALID_PULSE_TIME");}
            let elapsed=self.last_at.map_or(0.0,|last|(at-last)/1000.0);
            if self.visible&&self.playing&&visible&&playing&&self.running{self.pending+=elapsed.clamp(0.0,0.12)*speed;}
            self.last_at=Some(at);
        }else{
            let elapsed=input.num("elapsed");if !elapsed.is_finite(){return Err("INVALID_PULSE_TIME");}
            if visible&&playing&&self.running{self.pending+=elapsed.clamp(0.0,0.12)*speed;}
        }
        if !visible||!playing{self.pending=0.0;self.epoch+=u64::from(self.visible!=visible||self.playing!=playing);}
        self.visible=visible;self.playing=playing;Ok(())
    }
    pub(super) fn begin(&mut self,input:&V)->Result<V,&'static str>{
        self.observe(input)?;let budget=input.num("budget");if !budget.is_finite()||budget<0.0{return Err("INVALID_SIMULATION_BUDGET");}
        let mut out=self.status();
        if self.active.is_none()&&self.running&&self.pending>EPS&&self.visible&&self.playing{
            self.serial+=1;self.active=Some((self.serial,self.epoch,self.pending));
            out.set("request",obj(&[("ticket",n(self.serial as f64)),("minutes",n(self.pending)),("budget",n(budget)),("maxSteps",n(100.0))]));out.set("busy",boolean(true));
        }Ok(out)
    }
    pub(super) fn complete(&mut self,input:&V)->Result<V,&'static str>{
        let Some((ticket,epoch,requested))=self.active else{return Err("NO_ACTIVE_PULSE")};
        if input.num("ticket")!=ticket as f64{return Err("PULSE_TICKET_MISMATCH");}
        let result=input.get("result");let left=result.num("remaining");let steps=result.num("steps");
        if !left.is_finite()||left<0.0||left>requested||!steps.is_finite()||steps<0.0||steps.fract()!=0.0||steps>100.0{return Err("INVALID_SIMULATION_RESULT");}
        self.active=None;self.elapsed_ms=input.zero("ms");
        if epoch==self.epoch{self.running=result.get("running").truth();self.pending=if self.running{(self.pending-(requested-left)).max(0.0)}else{0.0};}
        Ok(self.status())
    }
    pub(super) fn fail(&mut self,input:&V)->Result<V,&'static str>{
        let Some((ticket,epoch,_))=self.active else{return Err("NO_ACTIVE_PULSE")};if input.num("ticket")!=ticket as f64{return Err("PULSE_TICKET_MISMATCH");}
        self.active=None;if epoch==self.epoch{self.running=false;self.pending=0.0;self.fault=Some(input.get("fault").clone());}Ok(self.status())
    }
    pub(super) fn status(&self)->V{let mut out=obj(&[("ok",boolean(self.running)),("pending",n(self.pending)),("busy",boolean(self.active.is_some())),("ms",n(self.elapsed_ms)),("epoch",n(self.epoch as f64))]);if let Some(fault)=&self.fault{out.set("fault",fault.clone());}out}
}
#[derive(Default)]
pub(super) struct Controls{next:u64,clocks:HashMap<u64,Clock>,compat:HashMap<u64,Compat>}
struct Compat{ticket:f64,requested:f64,left:f64,steps:usize,start:f64,budget:f64,waiting:Option<f64>}
impl Controls{
    pub(super) fn request(&mut self,v:&V)->V{
        let result=(||->Result<V,&'static str>{
            let op=v.get("action").text();if op=="create"{self.next+=1;self.clocks.insert(self.next,Clock::new());return Ok(n(self.next as f64));}
            let id=v.num("id");if !id.is_finite()||id<1.0||id.fract()!=0.0{return Err("INVALID_CLOCK_HANDLE");}
            if op=="close"{self.clocks.remove(&(id as u64));self.compat.remove(&(id as u64));return Ok(V::Null);}
            let clock=self.clocks.get_mut(&(id as u64)).ok_or("CLOCK_EXPIRED")?;
            if op=="compatStart"{let status=clock.begin(v)?;let request=status.get("request");if request.truth(){self.compat.insert(id as u64,Compat{ticket:request.num("ticket"),requested:request.num("minutes"),left:request.num("minutes"),steps:0,start:v.num("wall"),budget:v.num("budget"),waiting:None});}return Ok(status);}
            if op=="compatNext"{let batch=self.compat.get_mut(&(id as u64)).ok_or("NO_ACTIVE_COMPAT_BATCH")?;let mut running=true;if let Some(dt)=batch.waiting.take(){running=v.get("previous").truth();if running{batch.left=(batch.left-dt).max(0.0);batch.steps+=1;}else{batch.left=0.0;}}
                if !running||batch.left<=EPS||batch.steps>=100||batch.steps>0&&v.num("wall")-batch.start>=batch.budget{let mut status=clock.complete(&obj(&[("ticket",n(batch.ticket)),("result",obj(&[("remaining",n(batch.left)),("steps",n(batch.steps as f64)),("running",boolean(running))])),("ms",n(v.num("wall")-batch.start))]))?;status.set("steps",n(batch.steps as f64));status.set("done",boolean(true));self.compat.remove(&(id as u64));return Ok(status);}let dt=batch.left.min(0.1);batch.waiting=Some(dt);return Ok(obj(&[("dt",n(dt)),("done",boolean(false))]));}
            match op{"begin"=>clock.begin(v),"complete"=>clock.complete(v),"fail"=>clock.fail(v),"reset"=>{clock.reset();Ok(clock.status())},"status"=>Ok(clock.status()),_=>Err("UNKNOWN_CLOCK_ACTION")}
        })();result.unwrap_or_else(|e|obj(&[("error",text(e))]))
    }
}
