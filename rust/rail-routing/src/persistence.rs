//! Save format, migration, record policy and persistence scheduling. The host
//! executes IndexedDB/Storage operations and reports transaction completion.
use crate::{editor_support::*,value::Value as V};
use std::collections::{HashMap,VecDeque,HashSet};
const FIELDS:[&str;7]=["bestDay","bestHour","totalCompleted","totalPassengerKm","bestNetworkKm","bestLineKm","bestRevenue"];
pub(super) fn merge(values:&[V])->V{let mut out=obj(&[]);for key in FIELDS{let mut best:Option<f64>=None;for v in values{if let V::Number(n)=v.get(key){if n.is_finite()&&*n>=0.0{best=Some(best.map_or(*n,|b|b.max(*n)));}}}if let Some(best)=best{out.set(key,n(best));}}out}
fn decoded(text:&V)->V{if !text.truth(){return obj(&[("present",boolean(false))]);}match crate::json_codec::parse(text.text()){Ok(value)=>obj(&[("present",boolean(true)),("value",value)]),Err(e)=>obj(&[("present",boolean(true)),("error",boolean(true)),("code",crate::editor_support::text(&e))])}}
pub(super) fn world_records(s:&V,previous:&V)->V{
    if !matches!(s,V::Object(_)){return merge(&[previous.clone()]);}
    let tracks=s.get("tracks").array();let mut indices=HashMap::new();
    for(i,t)in tracks.iter().enumerate(){indices.insert(jsstring(t.get("id")),i);}
    let mut used=HashSet::new();let mut network=0.0;let mut longest=0.0_f64;
    for line in s.get("services").array(){let mut length=0.0;for id in line.get("trackIds").array(){if let Some(&index)=indices.get(&jsstring(id)){let km=tracks[index].zero("km");length+=km;if used.insert(index){network+=km;}}}longest=longest.max(length);}
    merge(&[previous.clone(),s.get("ridership").get("records").clone(),obj(&[("bestNetworkKm",n(network)),("bestLineKm",n(longest)),("bestRevenue",n(s.get("economy").zero("revenue")))])])
}
fn speed(v:&V)->V{if [1.0,3.0,6.0,12.0,24.0].contains(&v.n()){v.clone()}else{n(6.0)}}
pub(super) fn pack(state:V,mut runtime:V,settings:&V)->V{
    if let V::Object(rows)=&mut runtime{let defs=rows.iter().find(|(k,_)|k=="defs").map(|(_,v)|v.clone());rows.retain(|(k,_)|!matches!(k.as_str(),"plan"|"nativeView"|"defs"|"forecastStatus"));if let Some(defs)=defs{runtime.set("urbanDefs",defs);}}
    let mut out=obj(&[("format",text("rail-local-save")),("formatVersion",n(1.0)),("appVersion",n(72.0)),("region",state.get("region").clone()),("gameVersion",n(7.0)),("signature",crate::save::signature(&state)),("speed",speed(settings.get("speed"))),("playing",boolean(settings.get("playing").truth())),("personalRecords",world_records(&state,settings.get("personalRecords"))),("runtimeVersion",n(1.0)),("state",state),("runtime",runtime)]);
    for(key,value)in settings.entries(){if !has(&out,key){out.set(key,value.clone());}}out
}
pub(super) fn parse(text:&str)->Result<V,String>{
    let mut value=crate::json_codec::parse(text)?;
    if has(&value,"runtimeVersion")&&!eq(value.get("runtimeVersion"),&n(1.0)){return Err("VALIDATE_RUNTIME_VERSION".into());}
    if has(&value,"format")&&(value.get("format").text()!="rail-local-save"||!eq(value.get("formatVersion"),&n(1.0))){return Err("VALIDATE_FORMAT_VERSION".into());}
    // Same migration path as startup; malformed/unknown explicit envelopes never
    // fall back to a new empty game. Legacy imports restore world-only snapshots.
    if value.num("gameVersion")!=7.0{
        let legacy=if value.num("gameVersion")==6.0{value.get("state")}else if !has(&value,"gameVersion")&&!has(&value,"format"){&value}else{return Err("VALIDATE_GAME_VERSION".into());};
        if !crate::editor::validate_world(legacy,&crate::bootstrap::config()){return Err("VALIDATE_LEGACY_WORLD".into());}
        let region=legacy.get("region").clone();if !matches!(region.text(),"tokyo"|"gba"){return Err("VALIDATE_REGION".into());}
        let startup=crate::bootstrap::startup(&obj(&[("region",region),("stored",obj(&[("present",boolean(true)),("value",value.clone())]))]));
        if startup.get("blocked").truth(){return Err("VALIDATE_LEGACY_CHECKPOINT".into());}
        value=pack(startup.get("state").clone(),V::Null,&obj(&[("speed",startup.get("speed").clone()),("personalRecords",startup.get("records").clone())]));
    }
    let code=crate::save::run(&obj(&[("op",crate::editor_support::text("accept")),("value",value.clone())]),&crate::bootstrap::config()).n();
    if code!=0.0{return Err(format!("VALIDATE_SAVE_{}",code as u32));}
    value.set("region",value.get("state").get("region").clone());value.set("speed",speed(value.get("speed")));value.set("playing",boolean(false));value.set("personalRecords",merge(&[value.get("personalRecords").clone()]));Ok(value)
}
pub(super) fn encoded(value:&V,at:&V)->Result<V,String>{let text=crate::json_codec::encode(value)?;let bytes=text.len();Ok(obj(&[("text",crate::editor_support::text(&text)),("bytes",n(bytes as f64)),("savedAt",at.clone())]))}
#[derive(Default)]
struct Queue{serial:u64,active:Option<u64>,pending:VecDeque<u64>,coalesce:bool,started:u64,coalesced:u64,completed:u64,failed:u64,last_at:Option<f64>,last_success:V}
impl Queue{
    fn stats(&self)->V{obj(&[("active",boolean(self.active.is_some())),("pending",boolean(!self.pending.is_empty())),("started",n(self.started as f64)),("coalesced",n(self.coalesced as f64)),("completed",n(self.completed as f64)),("failed",n(self.failed as f64))])}
}
#[derive(Default)]
pub(super) struct Owner{next:u64,queues:HashMap<u64,Queue>,observed:HashMap<String,V>,last_error:Option<f64>}
impl Owner{
    pub(super) fn request(&mut self,v:&V)->V{let result=(||->Result<V,String>{match v.get("action").text(){
        "storageObserved"=>{self.observed.insert(v.get("key").text().into(),v.get("text").clone());Ok(V::Null)},
        "storageExpected"=>Ok(obj(&[("known",boolean(self.observed.contains_key(v.get("key").text()))),("text",self.observed.get(v.get("key").text()).cloned().unwrap_or(V::Null))])),
        "errorNotice"=>{let at=v.num("at");let due=at.is_finite()&&self.last_error.map_or(true,|last|at-last>=30000.0||at<last);if due{self.last_error=Some(at);}Ok(boolean(due))},
        "mergeRecords"=>{let mut result=merge(v.get("values").array());for key in ["bestDay","bestHour","totalCompleted"]{if !has(&result,key){result.set(key,n(0.0));}}Ok(result)},
        "fileSize"=>{let bytes=v.num("bytes");if !bytes.is_finite()||bytes<0.0||bytes>crate::json_codec::MAX_BYTES as f64{return Err("PARSE_SIZE".into());}Ok(V::Null)},
        "decode"=>Ok(decoded(v.get("text"))),"parse"=>parse(v.get("text").text()),"pack"=>Ok(pack(v.get("state").clone(),v.get("runtime").clone(),v.get("settings"))),
        "packView"=>{let mut result=pack(v.get("state").clone(),v.get("runtime").clone(),v.get("settings"));result.set("personalRecords",crate::save::run(&obj(&[("op",text("records")),("value",v.get("settings").get("personalRecords").clone())]),&crate::bootstrap::config()));Ok(result)},
        "parseView"=>{let value=parse(v.get("text").text())?;Ok(obj(&[("gameVersion",n(7.0)),("region",value.get("region").clone()),("state",value.get("state").clone()),("runtime",if value.get("runtime").truth(){value.get("runtime").clone()}else{V::Null}),("signature",value.get("signature").clone()),("speed",value.get("speed").clone()),("playing",boolean(false)),("personalRecords",value.get("personalRecords").clone()),("exportedAt",if matches!(value.get("exportedAt"),V::String(_)){value.get("exportedAt").clone()}else{V::Null})]))},
        "encode"=>encoded(v.get("value"),v.get("at")),
        "records"=>{let raw=crate::json_codec::parse(v.get("raw").text()).unwrap_or(V::Missing);let previous=crate::json_codec::parse(v.get("checkpoint").text()).unwrap_or(V::Missing);let value=world_records(v.get("state"),&merge(&[raw,v.get("value").clone(),previous.get("personalRecords").clone()]));let encoded=crate::json_codec::encode(&value)?;Ok(obj(&[("value",value),("text",text(&encoded))]))},
        "read"=>{let record=v.get("record");let legacy=v.get("legacy");let failed=v.get("failed").truth()||record.truth()&&!matches!(record.get("text"),V::String(_));if failed||!record.truth(){if legacy.truth(){return Ok(obj(&[("text",legacy.clone()),("source",text("legacy")),("error",boolean(failed))]));}if failed{return Err("READ_STORAGE".into());}return Ok(V::Null);}let mut out=record.clone();out.set("source",text("indexeddb"));Ok(out)},
        "prepareWrite"=>{let value=v.get("value");let record=if let V::String(s)=value{let parsed=crate::json_codec::parse(s)?;encoded(&parsed,v.get("at"))?}else{encoded(value,v.get("at"))?};Ok(record)},
        "committed"=>Ok(obj(&[("source",text("indexeddb")),("bytes",v.get("record").get("bytes").clone()),("savedAt",v.get("record").get("savedAt").clone()),("cleanup",boolean(matches!(v.get("legacy"),V::String(_))&&eq(v.get("legacy"),v.get("currentLegacy"))))])),
        "canSave"=>Ok(boolean(!v.get("fault").truth()&&!v.get("blocked").truth()&&!v.get("busy").truth())),
        "queueCreate"=>{self.next+=1;self.queues.insert(self.next,Queue{coalesce:!has(v,"coalesce")||v.get("coalesce").truth(),..Queue::default()});Ok(n(self.next as f64))},
        action=>{let q=self.queues.get_mut(&(v.num("id")as u64)).ok_or("SAVE_QUEUE_EXPIRED")?;match action{
            "queueRequest"=>{let start=q.active.is_none();let ticket=if !start&&q.coalesce&&!q.pending.is_empty(){q.coalesced+=1;*q.pending.back().unwrap()}else{q.serial+=1;let ticket=q.serial;if start{q.active=Some(ticket);q.started+=1;}else{q.pending.push_back(ticket);if q.coalesce{q.coalesced+=1;}}ticket};Ok(obj(&[("ticket",n(ticket as f64)),("start",boolean(start))]))},
            "queueFinish"=>{if q.active!=Some(v.num("ticket")as u64){return Err("SAVE_TICKET_MISMATCH".into());}if v.get("success").truth()&&!matches!(v.get("checkpoint"),V::Bool(false)){q.completed+=1;q.last_success=v.get("checkpoint").clone();}else{q.failed+=1;}q.active=q.pending.pop_front();if q.active.is_some(){q.started+=1;}Ok(obj(&[("next",q.active.map_or(V::Null,|id|n(id as f64)))]))},
            "queueStats"=>Ok(q.stats()),"queueLast"=>Ok(q.last_success.clone()),
            "queueObserve"=>{let at=v.num("at");if !at.is_finite(){return Err("INVALID_SAVE_TIME".into());}let due=q.last_at.map_or(false,|last|at-last>=10000.0);if q.last_at.is_none()||due||q.last_at.is_some_and(|last|at<last){q.last_at=Some(at);}Ok(boolean(due))},
            _=>Err("UNKNOWN_PERSISTENCE_ACTION".into())
        }}
    }})();result.unwrap_or_else(|e|obj(&[("error",text(&e))]))}
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn coalesced_requests_keep_last_success_after_failed_commit(){
        let mut owner=Owner::default();let id=owner.request(&obj(&[("action",text("queueCreate"))]));
        let request=|action:&str|obj(&[("action",text(action)),("id",id.clone())]);
        let first=owner.request(&request("queueRequest"));assert!(first.get("start").truth());
        let pending=owner.request(&request("queueRequest"));let replaced=owner.request(&request("queueRequest"));assert!(eq(pending.get("ticket"),replaced.get("ticket")));
        let mut finish=request("queueFinish");finish.set("ticket",first.get("ticket").clone());finish.set("success",boolean(true));finish.set("checkpoint",text("confirmed"));
        let next=owner.request(&finish);assert!(eq(next.get("next"),pending.get("ticket")));
        finish.set("ticket",pending.get("ticket").clone());finish.set("success",boolean(false));finish.set("checkpoint",text("failed"));owner.request(&finish);
        assert_eq!(owner.request(&request("queueLast")).text(),"confirmed");
        let stats=owner.request(&request("queueStats"));assert_eq!(stats.num("started"),2.0);assert_eq!(stats.num("failed"),1.0);
    }
    #[test]
    fn unknown_runtime_version_is_rejected_before_migration(){assert_eq!(parse("{\"gameVersion\":6,\"runtimeVersion\":42}").unwrap_err(),"VALIDATE_RUNTIME_VERSION");}
    #[test]
    fn version_fields_reject_boolean_and_string_coercion(){
        for version in ["true","false","null","\"1\"","2"]{let input=format!("{{\"gameVersion\":7,\"runtimeVersion\":{}}}",version);assert_eq!(parse(&input).unwrap_err(),"VALIDATE_RUNTIME_VERSION");}
        assert_eq!(parse("{\"format\":\"rail-local-save\",\"formatVersion\":true,\"gameVersion\":7}").unwrap_err(),"VALIDATE_FORMAT_VERSION");
    }
    #[test]
    fn records_use_per_field_maxima_and_ignore_invalid_values(){let merged=merge(&[obj(&[("bestDay",n(15.0)),("bestHour",n(f64::NAN))]),obj(&[("bestDay",n(10.0)),("totalCompleted",n(25.0))])]);assert_eq!(merged.num("bestDay"),15.0);assert_eq!(merged.num("totalCompleted"),25.0);assert!(!has(&merged,"bestHour"));}
}
