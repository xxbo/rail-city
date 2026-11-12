//! Session-owned initialization, forecast catalogs and revision acceptance.
//! Live runtime stepping and persistence continue in subsequent phases.
use crate::{assets, editor, editor_support::*, queues::Read, value, value::Value as V, CORE};
use std::{cell::RefCell, collections::VecDeque};

const VERSION: f64 = 1.0;
const RECEIPTS: usize = 128;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn same(a: &V, b: &V) -> bool {
    value::write(a)
        .iter()
        .map(|v| v.to_bits())
        .eq(value::write(b).iter().map(|v| v.to_bits()))
}
fn id(v: &V) -> Option<u64> {
    if integer(v) && v.n() >= 1.0 && v.n() <= MAX_SAFE {
        Some(v.n() as u64)
    } else {
        None
    }
}
fn revision(v: &V) -> Option<u64> {
    if integer(v) && v.n() >= 0.0 && v.n() <= MAX_SAFE {
        Some(v.n() as u64)
    } else {
        None
    }
}
fn envelope(ok: bool, sid: u64, rev: u64, result: V) -> V {
    obj(&[
        ("protocolVersion", n(VERSION)),
        ("ok", boolean(ok)),
        ("sessionId", n(sid as f64)),
        ("revision", n(rev as f64)),
        ("result", result),
        ("events", arr(vec![])),
    ])
}
fn error(code: &str, sid: u64, rev: u64) -> V {
    let mut v = envelope(false, sid, rev, V::Missing);
    v.set("error", obj(&[("code", text(code))]));
    v
}
// Validate lengths/tags before the existing trusted value reader. Malformed ABI calls
// produce a structured error, never a partially replaced session or a wasm trap.
fn valid_wire(v: &[f64]) -> bool {
    fn count(v: &[f64], at: &mut usize) -> Option<usize> {
        let x = *v.get(*at)?;
        *at += 1;
        if x.is_finite() && x >= 0.0 && x.fract() == 0.0 && x <= 2_000_000.0 {
            Some(x as usize)
        } else {
            None
        }
    }
    fn tree(v: &[f64], at: &mut usize, strings: usize, depth: usize) -> Option<()> {
        if depth > 80 {
            return None;
        }
        let tag = count(v, at)?;
        match tag {
            0..=3 => (),
            4 => {
                v.get(*at)?;
                *at += 1;
            }
            5 => {
                if count(v, at)? >= strings {
                    return None;
                }
            }
            6 => {
                for _ in 0..count(v, at)? {
                    tree(v, at, strings, depth + 1)?;
                }
            }
            7 => {
                for _ in 0..count(v, at)? {
                    if count(v, at)? >= strings {
                        return None;
                    }
                    tree(v, at, strings, depth + 1)?;
                }
            }
            _ => return None,
        }
        Some(())
    }
    fn check(v: &[f64]) -> Option<()> {
        let mut at = 0;
        let strings = count(v, &mut at)?;
        for _ in 0..strings {
            let len = count(v, &mut at)?;
            for _ in 0..len {
                let c = *v.get(at)?;
                at += 1;
                if !c.is_finite() || c < 0.0 || c > 65535.0 || c.fract() != 0.0 {
                    return None;
                }
            }
        }
        tree(v, &mut at, strings, 0)?;
        if at == v.len() {
            Some(())
        } else {
            None
        }
    }
    v.len() <= 2_000_000 && check(v).is_some()
}

struct Receipt {
    id: u64,
    request: V,
    response: V,
}
struct State {
    id: u64,
    revision: u64,
    world: V,
    config: V,
    high_water: u64,
    receipts: VecDeque<Receipt>,
}

/// Opaque owned session. Wire is the existing ordered f64 value codec, not JSON.
/// P3-0 accepts an existing cold checkpoint; new-game/RNG/runtime ownership is P3-1+.
#[derive(Default)]
pub struct SessionHost {
    next_id: u64,
    state: Option<State>,
    next_prepared: u64,
    sealed_start: Option<u64>,
    last_started: Option<(u64,u64)>,
    pending: Option<(u64, u64, u64, V)>,
    forecasts: crate::forecast_session::ForecastOwner,
    runtimes:crate::runtime_session::RuntimeOwner,
    clocks:crate::runtime_control::Controls,
    persistence:crate::persistence::Owner,
    platform:crate::platform::Owner,
    legacy_operations:crate::legacy_operations::Owner,
}
impl SessionHost {
    pub fn request_packed(&mut self, wire: &[f64], bytes: &[u8]) -> (Vec<f64>, Vec<u8>) {
        let out = match value::read_packed(wire, bytes) {
            Some(input) => self.handle(&input),
            None => error("INVALID_WIRE", 0, 0),
        };
        value::write_packed(&out)
    }
    pub fn request(&mut self, wire: &[f64]) -> Vec<f64> {
        if !valid_wire(wire) {
            return value::write(&error("INVALID_WIRE", 0, 0));
        }
        let input = value::read(&mut Read { v: wire, at: 0 });
        value::write(&self.handle(&input))
    }
    fn handle(&mut self, input: &V) -> V {
        if !matches!(input.get("protocolVersion"), V::Number(v) if *v == VERSION) {
            return error("UNSUPPORTED_PROTOCOL", 0, 0);
        }
        if input.get("op").text()=="platform"||input.get("op").text()=="viewModel"{let result=if input.get("op").text()=="platform"{self.platform.request(input)}else{crate::view_model::query(input)};if result.get("error").truth(){return error(result.get("error").text(),0,0);}return envelope(true,0,0,result);}
        if input.get("op").text()=="persistence"{let result=self.persistence.request(input);if matches!(result.get("error"),V::String(_)){return error(result.get("error").text(),0,0);}return envelope(true,0,0,result);}
        if input.get("op").text()=="legacyOperations"{let result=self.legacy_operations.request(input,&self.forecasts);if result.get("error").truth(){return error(result.get("error").text(),0,0);}return envelope(true,0,0,result);}
        if input.get("op").text()=="compat"{let mut out=crate::legacy::run(input);if matches!(input.get("action").text(),"cityEvaluate"|"evaluate"){let catalog=self.forecasts.adopt_legacy(input.get("state"),out.get("result"));if catalog.get("error").truth(){return error(catalog.get("error").text(),0,0);}crate::editor_support::del(out.get_mut("result"),"flows");out.get_mut("result").set("nativeCatalog",catalog);}return envelope(true,0,0,out);}
        if input.get("op").text()=="runtime"||input.get("op").text()=="clock"{
            let result=if input.get("op").text()=="runtime"{self.runtimes.request(input,&mut self.forecasts)}else{self.clocks.request(input)};
            if result.get("error").truth(){return error(result.get("error").text(),0,0);}return envelope(true,self.state.as_ref().map_or(0,|s|s.id),self.state.as_ref().map_or(0,|s|s.revision),result);
        }
        if input.get("op").text() == "forecast" {
            let result=self.forecasts.handle(input);
            if result.get("error").truth(){return error(result.get("error").text(),0,0);}
            return envelope(true,self.state.as_ref().map_or(0,|s|s.id),self.state.as_ref().map_or(0,|s|s.revision),result);
        }
        let op = input.get("op").text();
        if self.sealed_start.is_some() && matches!(op, "open"|"start"|"prepare_start"|"dispatch"|"close"|"cancel_start"|"commit_start") {
            return error("START_WRITE_PENDING",0,0);
        }
        if op == "activate_start" {
            if let Some((token, sid)) = self.last_started {
                if id(input.get("token")) == Some(token) && self.state.as_ref().is_some_and(|s| s.id == sid) {
                    return envelope(true,sid,0,V::Null);
                }
            }
        }
        if input.get("op").text() == "prepare_start" {
            if self.next_prepared as f64 >= MAX_SAFE {
                return error("PREPARED_LIMIT", 0, 0);
            }
            let startup = crate::bootstrap::startup(input);
            let world = startup.get("state");
            let cfg = crate::bootstrap::config();
            if !editor::validate_world(world, &cfg) || !editor::validate(world, &cfg) || !assets::economy_valid(world) {
                return error("INVALID_CHECKPOINT", 0, 0);
            }
            self.next_prepared += 1;
            let (sid, rev) = self.state.as_ref().map_or((0, 0), |s| (s.id, s.revision));
            self.pending = Some((self.next_prepared, sid, rev, startup.clone()));
            let mut result = startup;
            result.set("token", n(self.next_prepared as f64));
            return envelope(true, sid, rev, result);
        }
        if matches!(op,"commit_start"|"cancel_start"|"seal_start"|"abort_start_write"|"activate_start") {
            let Some((token, sid, rev, _)) = self.pending.as_ref() else {
                return error("NO_PREPARED_SESSION", 0, 0);
            };
            let (token,sid,rev) = (*token,*sid,*rev);
            if id(input.get("token")) != Some(token)
                || self.state.as_ref().map_or((0, 0), |s| (s.id, s.revision)) != (sid, rev) {
                return error("PREPARED_SESSION_EXPIRED",sid,rev);
            }
            if op == "seal_start" {
                if self.next_id as f64 >= MAX_SAFE { return error("SESSION_LIMIT",sid,rev); }
                self.sealed_start = Some(token);
                return envelope(true,sid,rev,V::Null);
            }
            if matches!(op,"activate_start"|"abort_start_write") && self.sealed_start != Some(token) {
                return error("START_NOT_SEALED",sid,rev);
            }
            self.sealed_start = None;
            let (_,_,_,startup) = self.pending.take().unwrap();
            if matches!(op, "cancel_start"|"abort_start_write") { return envelope(true,sid,rev,V::Null); }
            let mut out = self.handle(&obj(&[
                ("protocolVersion", n(1.0)), ("op", text("open")), ("world",startup.get("state").clone()),
                ("config", (*crate::bootstrap::config()).clone()),
            ]));
            if out.get("ok").truth() {
                if op == "activate_start" {
                    self.last_started = Some((token,self.next_id));
                    out.set("result",V::Null);
                } else { out.set("result",startup); }
            }
            return out;
        }
        if input.get("op").text() == "start" {
            let startup = crate::bootstrap::startup(input);
            let mut response = self.handle(&obj(&[
                ("protocolVersion", n(1.0)),
                ("op", text("open")),
                ("world", startup.get("state").clone()),
                ("config", (*crate::bootstrap::config()).clone()),
            ]));
            if response.get("ok").truth() {
                response.set("result", startup);
            }
            return response;
        }
        if input.get("op").text() == "open" {
            let w = input.get("world");
            let cfg = input.get("config");
            if input.get("runtime").truth() {
                return error("RUNTIME_NOT_SUPPORTED_YET", 0, 0);
            }
            if !["tokyo", "gba"].contains(&w.get("region").text())
                || w.num("routeModel") != 9.0
                || !editor::validate_world(w, cfg)
                || !editor::validate(w, cfg)
                || !assets::economy_valid(w)
            {
                return error("INVALID_CHECKPOINT", 0, 0);
            }
            if self.next_id as f64 >= MAX_SAFE {
                return error("SESSION_LIMIT", 0, 0);
            }
            self.next_id += 1;
            self.last_started = None;
            self.forecasts.advance_epoch();
            self.pending = None;
            self.state = Some(State {
                id: self.next_id,
                revision: 0,
                world: w.clone(),
                config: cfg.clone(),
                high_water: 0,
                receipts: VecDeque::new(),
            });
            return envelope(
                true,
                self.next_id,
                0,
                obj(&[(
                    "capabilities",
                    arr(vec![
                        text("cold-assets"),
                        text("snapshot"),
                        text("receipts"),
                    ]),
                )]),
            );
        }
        let Some(s) = self.state.as_mut() else {
            return error("NO_SESSION", 0, 0);
        };
        if id(input.get("sessionId")) != Some(s.id) {
            return error("SESSION_MISMATCH", s.id, s.revision);
        }
        if ["dispatch", "preview"].contains(&input.get("op").text())
            && value::write(input).len() > 4096
        {
            return error("COMMAND_TOO_LARGE", s.id, s.revision);
        }
        match input.get("op").text() {
            "query" => match input.get("view").text() {
                "snapshot" => envelope(true, s.id, s.revision, s.world.clone()),
                "status" => envelope(
                    true,
                    s.id,
                    s.revision,
                    obj(&[
                        ("highWater", n(s.high_water as f64)),
                        ("receiptLimit", n(RECEIPTS as f64)),
                    ]),
                ),
                "receipt" => {
                    if let Some(r) = s
                        .receipts
                        .iter()
                        .find(|r| Some(r.id) == id(input.get("commandId")))
                    {
                        let mut out = r.response.clone();
                        out.set("replayed", boolean(true));
                        out.set("currentRevision", n(s.revision as f64));
                        out
                    } else {
                        error("RECEIPT_UNAVAILABLE", s.id, s.revision)
                    }
                }
                _ => error("UNKNOWN_VIEW", s.id, s.revision),
            },
            "preview" => {
                if revision(input.get("expectedRevision")) != Some(s.revision) {
                    return error("REVISION_CONFLICT", s.id, s.revision);
                }
                Self::asset(s, input.get("command"), false)
            }
            "dispatch" => {
                let Some(cid) = id(input.get("commandId")) else {
                    return error("INVALID_COMMAND_ID", s.id, s.revision);
                };
                if let Some(r) = s.receipts.iter().find(|r| r.id == cid) {
                    if !same(&r.request, input) {
                        return error("COMMAND_ID_REUSED", s.id, s.revision);
                    }
                    let mut out = r.response.clone();
                    out.set("replayed", boolean(true));
                    out.set("currentRevision", n(s.revision as f64));
                    return out;
                }
                if cid <= s.high_water {
                    return error("COMMAND_EXPIRED", s.id, s.revision);
                }
                let out = if revision(input.get("expectedRevision")) != Some(s.revision) {
                    error("REVISION_CONFLICT", s.id, s.revision)
                } else if s.revision as f64 >= MAX_SAFE {
                    error("REVISION_LIMIT", s.id, s.revision)
                } else {
                    Self::asset(s, input.get("command"), true)
                };
                s.high_water = cid;
                if s.receipts.len() == RECEIPTS {
                    s.receipts.pop_front();
                }
                s.receipts.push_back(Receipt {
                    id: cid,
                    request: input.clone(),
                    response: out.clone(),
                });
                out
            }
            "close" => {
                let out = envelope(true, s.id, s.revision, V::Null);
                self.pending = None;
                self.last_started = None;
                self.state = None;
                self.forecasts.advance_epoch();
                out
            }
            _ => error("UNKNOWN_OPERATION", s.id, s.revision),
        }
    }
    fn asset(s: &mut State, command: &V, commit: bool) -> V {
        // P3-0 deliberately exercises existing cold rules, not live-edit migration.
        if !((command.get("kind").text() == "fleet" && command.get("op").text() == "purchase")
            || (command.get("kind").text() == "network"
                && command.get("op").text() == "renameStation"))
        {
            return error("COMMAND_NOT_SUPPORTED_YET", s.id, s.revision);
        }
        let out = assets::run(
            &obj(&[
                ("state", s.world.clone()),
                ("op", text("transaction")),
                ("command", command.clone()),
                ("commit", boolean(commit)),
                ("accounts", s.world.get("economy").clone()),
            ]),
            &s.config,
        );
        if out.get("result").get("error").truth() || has(out.get("result"), "insufficient") {
            let mut e = error("COMMAND_REJECTED", s.id, s.revision);
            e.set("details", out.get("result").clone());
            return e;
        }
        if commit {
            let mut candidate = s.world.clone();
            for patch in out.get("patch").array() {
                let row = patch.array();
                let key = row[0].text();
                match row[1].n() as u32 {
                    0 => (),
                    1 => {
                        let old = s.world.get(key).array();
                        let rows = row[2]
                            .array()
                            .iter()
                            .map(|x| {
                                if x.array()[0].n() >= 0.0 {
                                    old[x.array()[0].n() as usize].clone()
                                } else {
                                    x.array()[1].clone()
                                }
                            })
                            .collect();
                        candidate.set(key, arr(rows));
                    }
                    2 => candidate.set(key, row[2].clone()),
                    _ => return error("INVALID_RULE_PATCH", s.id, s.revision),
                }
            }
            if !editor::validate_world(&candidate, &s.config) || !assets::economy_valid(&candidate)
            {
                return error("INVALID_CANDIDATE", s.id, s.revision);
            }
            s.world = candidate;
            s.revision += 1;
        }
        let mut reply = envelope(
            true,
            s.id,
            s.revision,
            obj(&[
                ("value", out.get("result").clone()),
                ("quote", out.get("quote").clone()),
            ]),
        );
        if commit {
            reply.set(
                "events",
                arr(vec![obj(&[
                    ("type", text("WorldCommitted")),
                    ("revision", n(s.revision as f64)),
                ])]),
            );
        }
        reply
    }
}

thread_local! { static HOST: RefCell<SessionHost> = RefCell::new(SessionHost::default()); }
#[no_mangle]
pub extern "C" fn session_abi() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn session_contract() -> *const f64 {
    let input = CORE.with(|c| c.borrow().input.clone());
    let result = HOST.with(|h| h.borrow_mut().request(&input));
    CORE.with(|c| {
        let mut c = c.borrow_mut();
        c.output = result;
        c.output.as_ptr()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(h: &mut SessionHost, v: V) -> V {
        let data = h.request(&value::write(&v));
        value::read(&mut Read { v: &data, at: 0 })
    }
    #[test]
    fn malformed_inputs_and_versions_are_structured_failures() {
        let mut h = SessionHost::default();
        for wire in [
            vec![],
            vec![f64::NAN],
            vec![0.0, 7.0, 1.0],
            vec![1.0, -1.0],
            vec![0.0, 4.0],
        ] {
            let out = h.request(&wire);
            let v = value::read(&mut Read { v: &out, at: 0 });
            assert_eq!(v.get("error").get("code").text(), "INVALID_WIRE");
        }
        assert_eq!(
            call(&mut h, obj(&[])).get("error").get("code").text(),
            "UNSUPPORTED_PROTOCOL"
        );
        assert_eq!(
            call(
                &mut h,
                obj(&[("protocolVersion", n(1.0)), ("op", text("query"))])
            )
            .get("error")
            .get("code")
            .text(),
            "NO_SESSION"
        );
    }
    #[test]
    fn pure_rust_open_dispatch_query_with_frozen_world() {
        let bytes = include_bytes!("../../../scripts/fixtures/rail-p3-map65-session.wire");
        let wire: Vec<f64> = bytes
            .chunks_exact(8)
            .map(|x| f64::from_le_bytes(x.try_into().unwrap()))
            .collect();
        let mut h = SessionHost::default();
        let response = h.request(&wire);
        let opened = value::read(&mut Read {
            v: &response,
            at: 0,
        });
        assert!(opened.get("ok").truth());
        let cmd = obj(&[
            ("protocolVersion", n(1.0)),
            ("sessionId", n(1.0)),
            ("op", text("dispatch")),
            ("commandId", n(1.0)),
            ("expectedRevision", n(0.0)),
            (
                "command",
                obj(&[
                    ("kind", text("fleet")),
                    ("op", text("purchase")),
                    ("args", obj(&[("spec", text("6B")), ("count", n(1.0))])),
                ]),
            ),
        ]);
        let result = call(&mut h, cmd.clone());
        assert!(result.get("ok").truth());
        assert_eq!(result.num("revision"), 1.0);
        let again = call(&mut h, cmd);
        assert!(again.get("replayed").truth());
        assert_eq!(again.num("revision"), 1.0);
        let state = call(
            &mut h,
            obj(&[
                ("protocolVersion", n(1.0)),
                ("sessionId", n(1.0)),
                ("op", text("query")),
                ("view", text("snapshot")),
            ]),
        );
        assert_eq!(state.get("result").get("depot").get("stock").num("6B"), 1.0);
    }
}

#[no_mangle]
pub extern "C" fn session_packed() -> *const f64 {
    let input = CORE.with(|c| {
        let mut c = c.borrow_mut();
        let input=value::read_packed(&c.input,&c.cycle_bytes);
        // Decoding owns the request. Do not retain/copy a large wire beside its tree.
        if c.input.capacity()>131072{c.input=Vec::new();}else{c.input.clear();}
        if c.cycle_bytes.capacity()>1048576{c.cycle_bytes=Vec::new();}else{c.cycle_bytes.clear();}
        input
    });
    let out=match input{Some(input)=>HOST.with(|h|h.borrow_mut().handle(&input)),None=>error("INVALID_WIRE",0,0)};
    let (v,b)=value::write_packed(&out);
    CORE.with(|c| {
        let mut c = c.borrow_mut();
        c.output = v;
        c.cycle_bytes = b;
        c.output.as_ptr()
    })
}

// Numeric forecast tables bypass the generic value-node limit and retain f64 bits.
#[no_mangle]
pub extern "C" fn forecast_numeric() -> *const f64 {
    let result=CORE.with(|cell|{
        let c=cell.borrow();let input=&c.input;
        (||{
            let len=*input.first()?;
            if !len.is_finite()||len<0.0||len.fract()!=0.0||len as usize>input.len().saturating_sub(1){return None;}
            let split=1+len as usize;let metadata=value::read_packed(&input[1..split],&c.cycle_bytes)?;
            Some(HOST.with(|host|host.borrow_mut().forecasts.handle_numeric(&metadata,&input[split..])))
        })()
    }).unwrap_or_else(||obj(&[("error",text("INVALID_FORECAST_WIRE"))]));
    let (values,bytes)=value::write_packed(&result);
    CORE.with(|c|{let mut c=c.borrow_mut();c.output=values;c.cycle_bytes=bytes;c.output.as_ptr()})
}

// Opaque table transport: no generic Value tree for millions of numeric cells.
#[no_mangle]
pub extern "C" fn forecast_numeric_page() -> *const f64 {
    CORE.with(|cell| {
        let mut core = cell.borrow_mut();
        let page = HOST.with(|host| host.borrow().forecasts.transfer_page(&core.input));
        core.output = page.unwrap_or_default();
        core.output.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn forecast_numeric_export()->*const f64{
    let(id,flow_only)=CORE.with(|c|{let c=c.borrow();(c.input.first().copied().unwrap_or(0.0),c.input.get(1).copied()==Some(1.0))});
    let(values,bytes)=HOST.with(|host|host.borrow().forecasts.export_numeric(if id.is_finite()&&id>0.0&&id.fract()==0.0{id as u64}else{0},flow_only));
    CORE.with(|c|{let mut c=c.borrow_mut();c.output=values;c.cycle_bytes=bytes;c.output.as_ptr()})
}
