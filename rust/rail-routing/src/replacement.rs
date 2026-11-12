//! Page-side ownership of replacement requests. IndexedDB completion is the
//! durable commit point; a stored checkpoint can only be activated or reloaded.
use crate::{bootstrap, editor_support::*, value::Value as V};

#[derive(Clone, Copy, PartialEq)]
enum Phase { Reading, Preview, Preparing, Writing, Stored }
struct Request {
    ticket: u64,
    origin: String,
    target: String,
    reset: bool,
    resume: bool,
    token: Option<u64>,
    phase: Phase,
}
impl Request {
    fn view(&self) -> V {
        let regions = bootstrap::regions();
        let cfg = regions.get(&self.target);
        obj(&[("ticket", n(self.ticket as f64)), ("region", text(&self.target)),
            ("saveKey", cfg.get("saveKey").clone()), ("recordsKey", cfg.get("recordsKey").clone()),
            ("crossMap", boolean(self.origin != self.target)), ("resumePlaying", boolean(self.resume)),
            ("token", self.token.map_or(V::Null, |t| n(t as f64)))])
    }
}

#[derive(Default)]
pub(super) struct Owner { serial: u64, active: Option<Request> }
impl Owner {
    pub(super) fn event(&mut self, v: &V) -> Result<V,String> {
        let event = v.get("event").text();
        if matches!(event, "select" | "reset") {
            let origin = v.get("region").text();
            if !matches!(origin, "tokyo" | "gba") { return Err("VALIDATE_REGION".into()); }
            if self.active.as_ref().is_some_and(|r| !matches!(r.phase, Phase::Reading | Phase::Preview)) {
                return Err("REPLACEMENT_BUSY".into());
            }
            if self.serial >= 9_007_199_254_740_991 { return Err("REPLACEMENT_LIMIT".into()); }
            self.serial += 1;
            let reset = event == "reset";
            let resume = self.active.as_ref().map_or(v.get("playing").truth(), |r| r.resume);
            let r = Request { ticket:self.serial, origin:origin.into(), target:origin.into(), reset, resume,
                token:None, phase:if reset {Phase::Preparing} else {Phase::Reading} };
            let view = r.view();
            self.active = Some(r);
            return Ok(view);
        }
        let active = self.active.as_mut().filter(|r| v.num("ticket") == r.ticket as f64);
        if event == "current" { return Ok(boolean(active.is_some())); }
        let r = active.ok_or("REPLACEMENT_EXPIRED")?;
        match (event, r.phase) {
            ("preview", Phase::Reading) => {
                let region = v.get("region").text();
                if !matches!(region,"tokyo"|"gba") || !integer(v.get("token")) || v.num("token") < 1.0 {
                    return Err("RESTORE_TOKEN_MISMATCH".into());
                }
                r.target = region.into();
                r.token = Some(v.num("token") as u64);
                r.phase = Phase::Preview;
            }
            ("apply", Phase::Preview) => r.phase = Phase::Preparing,
            ("write", Phase::Preparing) => {
                if !integer(v.get("token")) || v.num("token") < 1.0
                    || (!r.reset && r.token != Some(v.num("token") as u64))
                    || !eq(r.view().get("saveKey"),v.get("saveKey")) { return Err("RESTORE_TOKEN_MISMATCH".into()); }
                r.token = Some(v.num("token") as u64);
                r.phase = Phase::Writing;
            }
            ("stored", Phase::Writing) => r.phase = Phase::Stored,
            ("stored", Phase::Stored) => (),
            ("failed", Phase::Preparing | Phase::Writing) => {
                let code=v.get("code").text();
                let retry = !r.reset && !v.get("unavailable").truth() && !code.starts_with("RESTORE_INVALID") && !matches!(code,
                    "RESTORE_STALE_PREVIEW"|"RESTORE_NO_PREVIEW"|"RESTORE_TOKEN_MISMATCH"|"COMMIT_CONFLICT");
                let mut view = r.view();
                view.set("retry",boolean(retry));
                if retry { r.phase = Phase::Preview; } else { self.active = None; }
                return Ok(view);
            }
            ("cancel", Phase::Reading | Phase::Preview) | ("activated", Phase::Stored) => {
                let view = r.view();
                self.active = None;
                return Ok(view);
            }
            _ => return Err("REPLACEMENT_BUSY".into()),
        }
        Ok(r.view())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(name:&str,ticket:f64)->V {
        obj(&[("event",text(name)),("region",text("tokyo")),("ticket",n(ticket)),("token",n(8.0))])
    }
    #[test]
    fn superseded_reads_and_failed_writes_cannot_advance_another_transaction() {
        let mut owner=Owner::default();
        let first=owner.event(&event("select",0.0)).unwrap().num("ticket");
        let second=owner.event(&event("select",0.0)).unwrap().num("ticket");
        assert!(owner.event(&event("preview",first)).is_err());
        let mut preview=event("preview",second);
        preview.set("region",text("gba"));
        assert!(owner.event(&preview).unwrap().get("crossMap").truth());
        let target=owner.event(&event("apply",second)).unwrap();
        let mut write=event("write",second);
        assert!(owner.event(&write).is_err());
        write.set("saveKey",target.get("saveKey").clone());
        owner.event(&write).unwrap();
        assert!(owner.event(&event("cancel",second)).is_err());
        assert!(owner.event(&event("reset",0.0)).is_err());
        assert!(owner.event(&event("failed",second)).unwrap().get("retry").truth());
        owner.event(&event("apply",second)).unwrap();
        owner.event(&write).unwrap();
        owner.event(&event("stored",second)).unwrap();
        assert!(owner.event(&event("failed",second)).is_err());
        owner.event(&event("activated",second)).unwrap();
        assert!(!owner.event(&event("current",second)).unwrap().truth());
    }
    #[test]
    fn a_changed_target_requires_a_new_preview() {
        let mut owner=Owner::default();
        let mut select=event("select",0.0);select.set("playing",boolean(true));
        let ticket=owner.event(&select).unwrap().num("ticket");
        owner.event(&event("preview",ticket)).unwrap();
        owner.event(&event("apply",ticket)).unwrap();
        let mut failure=event("failed",ticket);failure.set("code",text("COMMIT_CONFLICT"));
        let result=owner.event(&failure).unwrap();
        assert!(!result.get("retry").truth());
        assert!(result.get("resumePlaying").truth());
        assert!(owner.event(&event("apply",ticket)).is_err());
    }
}
