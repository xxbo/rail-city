//! Timer tickets for one foreground game's demand worker. The simulation owns
//! forecast validity; this owner only decides when another attempt may start.
use crate::{editor_support::*, value::Value as V};

const DEBOUNCE_MS: u32 = 120;
const RETRY_MS: u32 = 10_000;

#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Waiting(u64, f64),
    Running(u64),
}

#[derive(Default)]
pub(super) struct RefreshSchedule {
    phase: Phase,
    serial: u64,
    paused: bool,
    halted: bool,
    wanted: bool,
    manual: bool,
    held_due: Option<f64>,
}

impl RefreshSchedule {
    fn arm(&mut self, now: f64, delay: f64) -> V {
        if self.halted || !self.wanted || !matches!(self.phase, Phase::Idle) {
            return V::Null;
        }
        if self.paused { self.held_due.get_or_insert(now + delay); return V::Null; }
        self.serial += 1;
        self.phase = Phase::Waiting(self.serial, now + delay);
        obj(&[("ticket", n(self.serial as f64)), ("delay", n(delay))])
    }

    pub fn event(&mut self, v: &V) -> V {
        let now = v.zero("at");
        match v.get("event").text() {
            "signal" => {
                self.wanted = true;
                if v.get("manual").truth() {
                    self.manual = true;
                    self.held_due = None;
                    if matches!(self.phase, Phase::Waiting(..)) { self.phase = Phase::Idle; }
                }
                self.arm(now, if self.manual { 0.0 } else { DEBOUNCE_MS as f64 })
            }
            "wake" => {
                if !matches!(self.phase, Phase::Waiting(t, _) if t as f64 == v.num("ticket")) { return V::Null; }
                self.phase = Phase::Running(self.serial);
                self.wanted = false;
                obj(&[("run", boolean(true)), ("manual", boolean(std::mem::take(&mut self.manual)))])
            }
            "finish" => {
                if !matches!(self.phase, Phase::Running(t) if t as f64 == v.num("ticket")) { return V::Null; }
                self.phase = Phase::Idle;
                let error = v.get("error").text();
                let stale = matches!(error, "FORECAST_JOB_STALE" | "EDIT_REVISION_CONFLICT" | "FORECAST_PAUSED");
                self.halted |= v.get("fatal").truth();
                self.wanted |= v.get("dirty").truth() || !error.is_empty();
                // A failed forced begin may never have reached the runtime.
                let manual_retry = v.get("repeatManual").truth();
                let delay = if self.manual { 0 } else if !error.is_empty() && !stale { RETRY_MS } else { DEBOUNCE_MS };
                self.manual |= manual_retry;
                let mut out = obj(&[("next",self.arm(now, delay as f64))]);
                if !self.paused && !error.is_empty() {
                    out.set("status", text(if stale { "updating" } else { "error" }));
                }
                out
            }
            "pause" => {
                self.paused = true;
                if let Phase::Waiting(_, due) = self.phase { self.held_due = Some(due); self.phase = Phase::Idle; }
                obj(&[("clear", boolean(true))])
            }
            "resume" => {
                self.paused = false;
                let delay = self.held_due.take().map_or(DEBOUNCE_MS as f64, |due| (due - now).max(0.0));
                self.arm(now, delay)
            }
            _ => obj(&[("error", text("UNKNOWN_REFRESH_EVENT"))]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(name: &str, at: f64, ticket: f64) -> V {
        obj(&[("event", text(name)), ("at", n(at)), ("ticket", n(ticket))])
    }
    #[test]
    fn retry_deadline_survives_pause_and_manual_retry_supersedes_the_timer() {
        let mut s=RefreshSchedule::default();
        let first=s.event(&event("signal",0.0,0.0));
        assert_eq!(first.num("delay"),120.0);
        assert!(!s.event(&event("signal",5.0,0.0)).truth());
        let ticket=first.num("ticket");
        assert!(s.event(&event("wake",120.0,ticket)).get("run").truth());
        let mut fail=event("finish",160.0,ticket);
        fail.set("error",text("timeout"));
        let retry=s.event(&fail);
        assert_eq!(retry.get("next").num("delay"),10000.0);
        let old=retry.get("next").num("ticket");
        s.event(&event("pause",200.0,0.0));
        assert!(!s.event(&event("wake",220.0,old)).truth());
        let resumed=s.event(&event("resume",2160.0,0.0));
        assert_eq!(resumed.num("delay"),8000.0);
        let mut manual=event("signal",2161.0,0.0);
        manual.set("manual",boolean(true));
        let now=s.event(&manual);
        assert_eq!(now.num("delay"),0.0);
        assert!(!s.event(&event("wake",2162.0,resumed.num("ticket"))).truth());
        assert!(s.event(&event("wake",2162.0,now.num("ticket"))).get("manual").truth());
    }
    #[test]
    fn stale_results_coalesce_and_unknown_commits_stay_stopped() {
        let mut s=RefreshSchedule::default();
        let ticket=s.event(&event("signal",0.0,0.0)).num("ticket");
        s.event(&event("wake",120.0,ticket));
        assert!(!s.event(&event("signal",121.0,0.0)).truth());
        let mut stale=event("finish",125.0,ticket);
        stale.set("error",text("FORECAST_JOB_STALE"));
        let next=s.event(&stale);
        assert_eq!(next.get("status").text(),"updating");
        assert_eq!(next.get("next").num("delay"),120.0);
        let retry=next.get("next").num("ticket");
        s.event(&event("wake",245.0,retry));
        assert!(!s.event(&stale).truth());
        let mut failed=event("finish",246.0,retry);
        failed.set("error",text("RPC_COMMIT_UNKNOWN"));
        failed.set("fatal",boolean(true));
        assert!(!s.event(&failed).get("next").truth());
        assert!(!s.event(&event("signal",260.0,0.0)).truth());
    }
}
