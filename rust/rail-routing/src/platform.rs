//! Worker leases and request outcomes. JS holds only platform handles, timers
//! and Promise resolvers. A stateful timeout is an unknown commit, never replay.
use crate::{editor_support::*,value::Value as V};
use std::collections::{BTreeSet,HashMap};
#[derive(Default)]
struct Client{epoch:u64,serial:u64,pending:BTreeSet<u64>,active:bool,offered:bool,disposed:bool,poisoned:bool,stateful:bool,timeout:f64,last_poll:Option<f64>}
#[derive(Default)]
pub(super) struct Owner{serial:u64,clients:HashMap<u64,Client>}
impl Owner{
 pub(super) fn request(&mut self,v:&V)->V{let result=(||->Result<V,String>{
  let action=v.get("action").text();if action=="create"{let timeout=v.num("timeout");if !timeout.is_finite()||timeout<=0.0||timeout>300000.0{return Err("INVALID_RPC_TIMEOUT".into());}self.serial+=1;self.clients.insert(self.serial,Client{timeout,stateful:v.get("stateful").truth(),..Client::default()});return Ok(n(self.serial as f64));}
  let client=self.clients.get_mut(&(v.num("id")as u64)).ok_or("RPC_EXPIRED")?;
  match action{
   "status"=>Ok(obj(&[("active",boolean(client.active)),("pending",n(client.pending.len()as f64)),("disposed",boolean(client.disposed)),("poisoned",boolean(client.poisoned))])),
   "open"=>{if client.disposed{return Err("RPC_DISPOSED".into());}if client.poisoned{return Err("RPC_COMMIT_UNKNOWN".into());}if !client.active{client.epoch+=1;client.active=true;}Ok(n(client.epoch as f64))},
   "poll"=>{let at=v.num("at");if !at.is_finite(){return Err("INVALID_POLL_TIME".into());}let due=client.last_poll.map_or(true,|last|at-last>=10000.0||at<last);let selected=!v.get("busy").truth()&&(v.get("force").truth()||v.get("stale").truth()&&!v.get("failed").truth()||due);if selected{client.last_poll=Some(at);}Ok(boolean(selected))},
   "offer"=>{let accept=client.active&&!client.disposed&&!client.poisoned&&!client.offered&&client.pending.is_empty();if accept{client.offered=true;}Ok(boolean(accept))},
   "request"=>{if client.disposed{return Err("RPC_DISPOSED".into());}if client.poisoned{return Err("RPC_COMMIT_UNKNOWN".into());}if !client.active{return Err("RPC_UNAVAILABLE".into());}client.offered=false;client.serial+=1;client.pending.insert(client.serial);Ok(obj(&[("ticket",n(client.serial as f64)),("epoch",n(client.epoch as f64)),("timeout",n(client.timeout))]))},
   "settle"=>Ok(boolean(v.num("epoch")==client.epoch as f64&&client.pending.remove(&(v.num("ticket")as u64)))),
   "fault"|"timeout"|"dispose"=>{
    if action!="dispose"&&(v.num("epoch")!=client.epoch as f64||action=="timeout"&&!client.pending.contains(&(v.num("ticket")as u64))){return Ok(obj(&[("accepted",boolean(false))]));}
    let pending=arr(client.pending.iter().map(|id|n(*id as f64)).collect());client.poisoned|=client.stateful&&!client.pending.is_empty();client.pending.clear();client.offered=false;client.active=false;client.epoch+=1;client.disposed|=action=="dispose";
    Ok(obj(&[("accepted",boolean(true)),("reject",pending),("unknownCommit",boolean(client.poisoned)),("terminate",boolean(true))]))
   },_=>Err("UNKNOWN_RPC_ACTION".into())
  }
 })();result.unwrap_or_else(|e|obj(&[("error",text(&e))]))}
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn settled_timeout_and_replaced_worker_cannot_cancel_new_requests(){let mut owner=Owner::default();let id=owner.request(&obj(&[("action",text("create")),("timeout",n(1000.0))]));let request=|action:&str|obj(&[("action",text(action)),("id",id.clone())]);let epoch=owner.request(&request("open"));let job=owner.request(&request("request"));let mut event=request("settle");event.set("epoch",epoch.clone());event.set("ticket",job.get("ticket").clone());assert!(owner.request(&event).truth());event.set("action",text("timeout"));assert!(!owner.request(&event).get("accepted").truth());event.set("action",text("fault"));assert!(owner.request(&event).get("accepted").truth());let next=owner.request(&request("open"));assert!(!eq(&epoch,&next));let _job=owner.request(&request("request"));assert!(!owner.request(&event).get("accepted").truth());assert_eq!(owner.request(&request("status")).num("pending"),1.0);}
 #[test]fn uncertain_stateful_request_is_not_replayed(){let mut owner=Owner::default();let id=owner.request(&obj(&[("action",text("create")),("timeout",n(1000.0)),("stateful",boolean(true))]));let epoch=owner.request(&obj(&[("action",text("open")),("id",id.clone())]));let job=owner.request(&obj(&[("action",text("request")),("id",id.clone())]));let outcome=owner.request(&obj(&[("action",text("timeout")),("id",id.clone()),("epoch",epoch),("ticket",job.get("ticket").clone())]));assert!(outcome.get("unknownCommit").truth());assert_eq!(owner.request(&obj(&[("action",text("open")),("id",id)])).get("error").text(),"RPC_COMMIT_UNKNOWN");}
}
