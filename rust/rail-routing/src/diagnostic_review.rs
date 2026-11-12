//! Actual operational change observations; forecasts never replace measured counters.
use crate::{
    diagnostics::{add, fallback_value, json},
    editor_support::*,
    value::Value as V,
};
const FIELDS: [&str; 5] = [
    "boarded",
    "completed",
    "waitMinutes",
    "revenue",
    "operating",
];
const AGG: [&str; 13] = [
    "minutes",
    "boarded",
    "completed",
    "waitMinutes",
    "revenue",
    "operating",
    "grant",
    "loadSum",
    "loadMinutes",
    "qualitySum",
    "qualityMinutes",
    "peakMinutes",
    "unused",
];
fn empty() -> V {
    V::Object(AGG[..12].iter().map(|k| (k.to_string(), n(0.0))).collect())
}
fn day(m: f64) -> f64 {
    ((m - 420.0) / 1440.0).floor() + 1.0
}
fn clock(m: f64) -> f64 {
    ((m % 1440.0) + 1440.0) % 1440.0
}
fn peak(m: f64) -> bool {
    let h = clock(m);
    (h >= 420.0 && h < 540.0) || (h >= 1020.0 && h < 1140.0)
}
fn open(l: &V, m: f64) -> bool {
    let h = clock(m);
    h >= l.num("open") && h < l.num("close")
}
fn raw(s: &V, id: &str, number: f64) -> V {
    let q = s.get("ridership");
    let d = if q.get("current").num("number") == number {
        q.get("current")
    } else {
        q.get("history")
            .array()
            .iter()
            .find(|d| d.num("number") == number)
            .unwrap_or(&V::Missing)
    };
    let r = d.get("lines").get(id);
    V::Object(
        FIELDS
            .iter()
            .map(|k| (k.to_string(), n(r.zero(k))))
            .collect(),
    )
}
fn cursor(s: &V, m: f64) -> V {
    obj(&[
        ("minute", n(m)),
        ("day", n(day(m))),
        (
            "rows",
            V::Object(
                s.get("services")
                    .array()
                    .iter()
                    .map(|l| {
                        (
                            l.get("id").text().into(),
                            raw(s, l.get("id").text(), day(m)),
                        )
                    })
                    .collect(),
            ),
        ),
    ])
}
fn context(s: &V) -> V {
    obj(&[
        ("people", n(s.get("urban").get("totals").zero("people"))),
        ("jobs", n(s.get("urban").get("totals").zero("jobs"))),
    ])
}
fn config(l: &V) -> V {
    obj(&[
        ("dispatch", l.get("dispatch").clone()),
        (
            "patterns",
            if l.get("patterns").truth() {
                l.get("patterns").clone()
            } else {
                V::Null
            },
        ),
        ("fares", crate::tariffs::bands(l)),
        ("stops", l.get("stops").clone()),
        ("tracks", l.get("trackIds").clone()),
        ("open", l.get("open").clone()),
        ("close", l.get("close").clone()),
        (
            "loop",
            if l.get("loopDirection").truth() {
                l.get("loopDirection").clone()
            } else {
                text("both")
            },
        ),
        ("spec", l.get("stockSpec").clone()),
    ])
}
fn next_at(r: &mut V) {
    let mut at = r.get("cursor").num("minute") + 5.0;
    for e in r.get("events").array() {
        if e.get("status").text() == "warming" {
            at = min(at, e.num("warmUntil"));
        }
        if e.get("status").text() == "observing" {
            at = min(at, e.num("until"));
        }
    }
    r.set("nextAt", n(at));
}
fn accumulate(a: &mut V, row: &V, minutes: f64, is_peak: bool) {
    add(a, "minutes", minutes);
    for k in FIELDS {
        add(a, k, row.zero(k));
    }
    add(a, "grant", row.zero("grant"));
    if !matches!(row.get("load"), V::Null) {
        add(a, "loadSum", row.num("load") * minutes);
        add(a, "loadMinutes", minutes);
    }
    if !matches!(row.get("quality"), V::Null) {
        add(a, "qualitySum", row.num("quality") * minutes);
        add(a, "qualityMinutes", minutes);
    }
    if is_peak {
        add(a, "peakMinutes", minutes);
    }
}
pub(super) fn sample_due(minute: f64, next: f64, force: bool) -> bool {
    force || !(minute + 1e-7 < next)
}
fn sample(s: &mut V, rt: &V, force: bool, cfg: &V) -> bool {
    let r = s.get("operationsReview");
    let to = rt.num("minute");
    if !r.truth() || !sample_due(to, r.num("nextAt"), force) {
        return false;
    }
    let from = r.get("cursor").num("minute");
    let duration = to - from;
    if duration < 1e-7 {
        return false;
    }
    if duration > 5.2 || duration < 0.0 {
        let cur = cursor(s, to);
        let r = s.get_mut("operationsReview");
        r.set("buckets", arr(vec![]));
        for e in r.get_mut("events").array_mut() {
            if ["observing", "warming"].contains(&e.get("status").text()) {
                e.set("status", text("interrupted"));
                e.set("reason", text("采样中断"));
            }
        }
        r.set("cursor", cur);
        add(r, "revision", 1.0);
        next_at(r);
        return true;
    }
    let mut loads = obj(&[]);
    for t in rt.get("trains").array() {
        let id = if t.get("parentLine").truth() {
            t.get("parentLine")
        } else {
            t.get("service")
        };
        let row = loads.get_mut(id.text());
        add(row, "onboard", t.num("onboard"));
        add(row, "capacity", t.num("capacity"));
    }
    let mut rows = obj(&[]);
    for l in s.get("services").array() {
        let id = l.get("id").text();
        let previous = r.get("cursor").get("rows").get(id);
        if !previous.truth() {
            continue;
        }
        let current = raw(s, id, day(to));
        let mut values = obj(&[]);
        for k in FIELDS {
            let amount = if r.get("cursor").num("day") != day(to) {
                raw(s, id, r.get("cursor").num("day")).num(k) - previous.num(k) + current.num(k)
            } else {
                current.num(k) - previous.num(k)
            };
            values.set(k, n(max(0.0, amount)));
        }
        values.set(
            "grant",
            n(values.num("revenue") * cfg.get("balance").num("GRANT_RATE")),
        );
        values.set(
            "load",
            if loads.get(id).get("capacity").truth() {
                n(loads.get(id).num("onboard") / loads.get(id).num("capacity"))
            } else {
                V::Null
            },
        );
        values.set(
            "quality",
            fallback_value(
                s.get("ridership").get("lines").get(id).get("satisfaction"),
                &V::Null,
            )
            .clone(),
        );
        values.set("open", boolean(open(l, from + 1e-5) && open(l, to - 1e-5)));
        rows.set(id, values);
    }
    let bucket = obj(&[
        ("from", n(from)),
        ("to", n(to)),
        ("peak", boolean(peak((from + to) / 2.0))),
        ("rows", rows.clone()),
    ]);
    let lines = s.get("services").clone();
    let environment = context(s);
    let cur = cursor(s, to);
    let r = s.get_mut("operationsReview");
    r.get_mut("buckets").array_mut().push(bucket.clone());
    r.get_mut("buckets")
        .array_mut()
        .retain(|b| b.num("to") > to - 95.0);
    let bs = r.get_mut("buckets").array_mut();
    if bs.len() > 18 {
        bs.drain(..bs.len() - 18);
    }
    for e in r.get_mut("events").array_mut() {
        if e.get("status").text() == "observing" && from >= e.num("afterFrom") - 1e-5 {
            let row = rows.get(e.get("line").text());
            if row.get("open").truth() {
                accumulate(
                    e.get_mut("after"),
                    row,
                    duration,
                    bucket.get("peak").truth(),
                );
            } else {
                e.set("status", text("interrupted"));
                e.set("reason", text("运营时段结束或线路已删除"));
            }
            if e.get("status").text() == "observing" && to + 1e-7 >= e.num("until") {
                e.set("status", text("complete"));
                e.set("afterTo", n(to));
                e.set("environmentAfter", environment.clone());
            }
        }
        if e.get("status").text() == "warming" && to + 1e-7 >= e.num("warmUntil") {
            let l = lines
                .array()
                .iter()
                .find(|l| eq(l.get("id"), e.get("line")));
            match l {
                None => {
                    e.set("status", text("interrupted"));
                    e.set("reason", text("线路已删除"));
                }
                Some(l) if !open(l, to + 1e-5) => {
                    e.set("awaitOpening", boolean(true));
                    e.set(
                        "warmUntil",
                        n(to + (l.num("open") - clock(to) + 1440.0) % 1440.0 + 15.0),
                    );
                }
                Some(_) => {
                    e.set("awaitOpening", boolean(false));
                    e.set("status", text("observing"));
                    e.set("afterFrom", n(to));
                    e.set("until", n(to + e.num("target")));
                }
            }
        }
    }
    r.set("cursor", cur);
    add(r, "revision", 1.0);
    next_at(r);
    true
}
fn baseline(s: &V, id: &str, minute: f64) -> V {
    let r = s.get("operationsReview");
    let mut a = empty();
    let mut end = minute;
    let mut from = minute;
    for b in r.get("buckets").array().iter().rev() {
        if (b.num("to") - end).abs() > 0.2 || b.num("from") < minute - 60.0 - 1e-5 {
            break;
        }
        let row = b.get("rows").get(id);
        if !row.get("open").truth() {
            break;
        }
        accumulate(
            &mut a,
            row,
            b.num("to") - b.num("from"),
            b.get("peak").truth(),
        );
        end = b.num("from");
        from = end;
    }
    a.set("from", n(from));
    a.set("to", n(minute));
    a
}
fn prepare(s: &mut V, rt: &V, cfg: &V) -> V {
    if !s.get("operationsReview").truth() {
        return V::Null;
    }
    sample(s, rt, true, cfg);
    obj(&[
        ("minute", rt.get("minute").clone()),
        ("environment", context(s)),
        (
            "lines",
            V::Object(
                s.get("services")
                    .array()
                    .iter()
                    .map(|l| {
                        let c = config(l);
                        (
                            l.get("id").text().into(),
                            obj(&[
                                ("name", l.get("name").clone()),
                                ("config", text(&json(&c))),
                                ("plan", crate::diagnostics::clone_json(&c)),
                                (
                                    "baseline",
                                    baseline(s, l.get("id").text(), rt.num("minute")),
                                ),
                            ]),
                        )
                    })
                    .collect(),
            ),
        ),
    ])
}
fn describe(a: &V, b: &V) -> V {
    if !a.truth() {
        return arr(vec![text("新建线路")]);
    }
    if !b.truth() {
        return arr(vec![text("删除线路")]);
    }
    let fields = [
        ("dispatch", "配车 / 投放"),
        ("patterns", "交路"),
        ("fares", "票价"),
        ("stops", "车站"),
        ("tracks", "线形"),
        ("open", "运营时段"),
        ("close", "运营时段"),
        ("loop", "环线方向"),
    ];
    arr(unique(
        &fields
            .iter()
            .filter(|(k, _)| json(a.get(k)) != json(b.get(k)))
            .map(|(_, label)| text(label))
            .collect::<Vec<_>>(),
    ))
}
fn summary(p: &V) -> V {
    if !p.truth() {
        return V::Null;
    }
    obj(&[
        (
            "dispatch",
            if p.get("dispatch").truth() {
                crate::diagnostics::clone_json(p.get("dispatch"))
            } else {
                V::Null
            },
        ),
        (
            "patterns",
            if p.get("patterns").truth() {
                arr(p
                    .get("patterns")
                    .array()
                    .iter()
                    .take(8)
                    .map(|p| p.get("kind").clone())
                    .collect())
            } else {
                arr(vec![text("local")])
            },
        ),
        (
            "fares",
            if p.get("fares").truth() {
                p.get("fares").clone()
            } else {
                V::Null
            },
        ),
        ("stations", n(unique(p.get("stops").array()).len() as f64)),
        ("open", p.get("open").clone()),
        ("close", p.get("close").clone()),
    ])
}
fn record(s: &mut V, rt: &V, mark: &V) -> V {
    if !s.get("operationsReview").truth() || !mark.truth() {
        return arr(vec![]);
    }
    let ids = unique(
        &mark
            .get("lines")
            .entries()
            .iter()
            .map(|r| text(&r.0))
            .chain(
                s.get("services")
                    .array()
                    .iter()
                    .map(|l| l.get("id").clone()),
            )
            .collect::<Vec<_>>(),
    );
    let mut changed = vec![];
    for id in ids {
        let a = mark.get("lines").get(id.text());
        let l = s
            .get("services")
            .array()
            .iter()
            .find(|l| eq(l.get("id"), &id))
            .unwrap_or(&V::Missing);
        let p = if l.truth() { config(l) } else { V::Null };
        if a.truth() && l.truth() && a.get("config").text() == json(&p) {
            continue;
        }
        let kinds = describe(a.get("plan"), &p);
        if !kinds.array().is_empty() {
            changed.push((id, a.clone(), l.clone(), p, kinds));
        }
    }
    if changed.is_empty() {
        return arr(vec![]);
    }
    let cur = cursor(s, rt.num("minute"));
    let r = s.get_mut("operationsReview");
    for e in r.get_mut("events").array_mut() {
        if ["pending", "warming", "observing"].contains(&e.get("status").text()) {
            if changed.iter().any(|c| eq(&c.0, e.get("line"))) {
                e.set("status", text("interrupted"));
                e.set("reason", text("被同线后续调整打断"));
            } else {
                e.set("otherChanges", boolean(true));
            }
        }
    }
    for (id, a, l, p, kinds) in &changed {
        let before = if a.get("baseline").truth() {
            a.get("baseline").clone()
        } else {
            let mut a = empty();
            a.set("from", mark.get("minute").clone());
            a.set("to", mark.get("minute").clone());
            a
        };
        let e = obj(&[
            ("id", r.get("nextId").clone()),
            ("line", id.clone()),
            (
                "name",
                if l.get("name").truth() {
                    l.get("name").clone()
                } else {
                    a.get("name").clone()
                },
            ),
            ("kinds", kinds.clone()),
            ("minute", mark.get("minute").clone()),
            ("before", before.clone()),
            ("beforePlan", summary(a.get("plan"))),
            ("afterPlan", summary(p)),
            (
                "target",
                n(if before.num("minutes") >= 30.0 - 1e-5 {
                    before.num("minutes")
                } else {
                    60.0
                }),
            ),
            (
                "status",
                text(if l.truth() { "pending" } else { "deleted" }),
            ),
            ("after", empty()),
            ("environmentBefore", mark.get("environment").clone()),
            ("otherChanges", boolean(false)),
            (
                "baselineChanges",
                boolean(r.get("events").array().iter().any(|e| {
                    e.num("minute") >= before.num("from") && e.num("minute") < mark.num("minute")
                })),
            ),
            ("reason", text(if l.truth() { "" } else { "线路已删除" })),
        ]);
        add(r, "nextId", 1.0);
        r.get_mut("events").array_mut().insert(0, e);
    }
    r.get_mut("events").array_mut().truncate(20);
    r.set("cursor", cur);
    add(r, "revision", 1.0);
    next_at(r);
    arr(changed.into_iter().map(|r| r.0).collect())
}
fn observe(s: &mut V, rt: &V, id: &V, cfg: &V) -> V {
    let l = s
        .get("services")
        .array()
        .iter()
        .find(|l| eq(l.get("id"), id))
        .unwrap_or(&V::Missing)
        .clone();
    if !l.truth() {
        return V::Null;
    }
    let mark = prepare(s, rt, cfg);
    if !mark.truth() {
        return V::Null;
    }
    let before = mark.get("lines").get(id.text()).get("baseline");
    let environment = context(s);
    let r = s.get_mut("operationsReview");
    for e in r.get_mut("events").array_mut() {
        if eq(e.get("line"), id)
            && ["pending", "warming", "observing"].contains(&e.get("status").text())
        {
            e.set("status", text("interrupted"));
            e.set("reason", text("已重新开始观察"));
        }
    }
    let e = obj(&[
        ("id", r.get("nextId").clone()),
        ("line", id.clone()),
        ("name", l.get("name").clone()),
        ("kinds", arr(vec![text("手动复核")])),
        ("minute", rt.get("minute").clone()),
        ("before", before.clone()),
        ("beforePlan", summary(&config(&l))),
        ("afterPlan", summary(&config(&l))),
        (
            "target",
            n(if before.num("minutes") >= 30.0 - 1e-5 {
                before.num("minutes")
            } else {
                60.0
            }),
        ),
        ("status", text("pending")),
        ("after", empty()),
        ("environmentBefore", environment),
        ("otherChanges", boolean(false)),
        (
            "baselineChanges",
            boolean(r.get("events").array().iter().any(|e| {
                e.num("minute") >= before.num("from") && e.num("minute") < rt.num("minute")
            })),
        ),
    ]);
    add(r, "nextId", 1.0);
    r.get_mut("events").array_mut().insert(0, e.clone());
    r.get_mut("events").array_mut().truncate(20);
    add(r, "revision", 1.0);
    next_at(r);
    e
}
fn ready(s: &mut V, minute: f64) {
    let lines = s.get("services").clone();
    let r = s.get_mut("operationsReview");
    let mut changed = false;
    for e in r.get_mut("events").array_mut() {
        if e.get("status").text() == "pending" {
            e.set("status", text("warming"));
            e.set("readyAt", n(minute));
            let l = lines
                .array()
                .iter()
                .find(|l| eq(l.get("id"), e.get("line")));
            let awaiting = l.map_or(false, |l| !open(l, minute));
            e.set("awaitOpening", boolean(awaiting));
            e.set(
                "warmUntil",
                n(minute
                    + if awaiting {
                        (l.unwrap().num("open") - clock(minute) + 1440.0) % 1440.0
                    } else {
                        0.0
                    }
                    + 15.0),
            );
            changed = true;
        }
    }
    if changed {
        add(r, "revision", 1.0);
        next_at(r);
    }
}
fn rates(a: &V) -> V {
    let h = a.num("minutes") / 60.0;
    obj(&[
        (
            "boarded",
            if h != 0.0 {
                n(a.num("boarded") / h)
            } else {
                V::Null
            },
        ),
        (
            "completed",
            if h != 0.0 {
                n(a.num("completed") / h)
            } else {
                V::Null
            },
        ),
        (
            "wait",
            if a.get("boarded").truth() {
                n(a.num("waitMinutes") / a.num("boarded"))
            } else {
                V::Null
            },
        ),
        (
            "profit",
            if h != 0.0 {
                n((a.num("revenue") + a.num("grant") - a.num("operating")) / h)
            } else {
                V::Null
            },
        ),
        (
            "load",
            if a.num("loadMinutes") >= a.num("minutes") * 0.5 && a.get("loadMinutes").truth() {
                n(a.num("loadSum") / a.num("loadMinutes"))
            } else {
                V::Null
            },
        ),
        (
            "quality",
            if a.get("qualityMinutes").truth() {
                n(a.num("qualitySum") / a.num("qualityMinutes"))
            } else {
                V::Null
            },
        ),
    ])
}
fn view(e: &V) -> V {
    let before = rates(e.get("before"));
    let after = rates(e.get("after"));
    let enough =
        e.get("before").num("minutes") >= 30.0 - 1e-5 && e.get("status").text() == "complete";
    let mut flags = vec![];
    if e.get("otherChanges").truth() {
        flags.push(text("同期有其他线网调整"));
    }
    if e.get("baselineChanges").truth() {
        flags.push(text("基线含近期调整"));
    }
    if e.get("before").get("minutes").truth()
        && e.get("after").get("minutes").truth()
        && (e.get("before").num("peakMinutes") / e.get("before").num("minutes")
            - e.get("after").num("peakMinutes") / e.get("after").num("minutes"))
        .abs()
            > 0.001
    {
        flags.push(text("高峰 / 平峰占比不同"));
    }
    if e.get("environmentAfter").truth() {
        let a = e.get("environmentBefore");
        let b = e.get("environmentAfter");
        if (b.num("people") - a.num("people")).abs() > max(100.0, a.num("people") * 0.05)
            || (b.num("jobs") - a.num("jobs")).abs() > max(100.0, a.num("jobs") * 0.05)
        {
            flags.push(text("城市人口或岗位有变化"));
        }
    }
    let mut good = 0;
    let mut bad = 0;
    if enough {
        for (key, sign, minimum) in [
            ("boarded", 1.0, 20.0),
            ("completed", 1.0, 20.0),
            ("wait", -1.0, 0.5),
            ("profit", 1.0, 100.0),
            ("quality", 1.0, 0.02),
        ] {
            let a = before.get(key);
            let b = after.get(key);
            if matches!(a, V::Null) || matches!(b, V::Null) {
                continue;
            }
            if ["wait", "completed", "boarded"].contains(&key)
                && min(
                    e.get("before").num("boarded"),
                    e.get("after").num("boarded"),
                ) < 20.0
            {
                continue;
            }
            let change = b.n() - a.n();
            if change.abs() < max(minimum, a.n().abs() * 0.1) {
                continue;
            }
            if change * sign > 0.0 {
                good += 1;
            } else {
                bad += 1;
            }
        }
    }
    let label = match e.get("status").text() {
        "pending" => "等待需求更新",
        "warming" => {
            if e.get("awaitOpening").truth() {
                "等待开行"
            } else {
                "预热中"
            }
        }
        "observing" => "观察中",
        "interrupted" => "观察已中断",
        "deleted" => "线路已删除",
        _ => {
            if e.get("before").num("minutes") < 30.0 - 1e-5 {
                "基线不足"
            } else if good > 0 && bad > 0 {
                "指标有升有降"
            } else if good > 1 {
                "多项指标向好"
            } else if good > 0 {
                "有改善信号"
            } else if bad > 0 {
                "需要复核"
            } else {
                "变化不明显"
            }
        }
    };
    let mut out = e.clone();
    out.set("beforeRates", before);
    out.set("afterRates", after);
    out.set("comparable", boolean(enough));
    out.set("flags", arr(flags));
    out.set("statusLabel", text(label));
    out
}
fn positive(v: &V) -> bool {
    finite(v) && v.n() >= 0.0
}
pub(super) fn valid(s: &V) -> bool {
    let r = s.get("operationsReview");
    if matches!(r, V::Missing) {
        return true;
    }
    let aggregate = |a: &V| {
        a.truth() && a.num("minutes") <= 60.2 && AGG[..12].iter().all(|k| positive(a.get(k)))
    };
    if !r.truth()
        || r.num("version") != 1.0
        || !integer(r.get("nextId"))
        || r.num("nextId") < 1.0
        || !integer(r.get("revision"))
        || !positive(r.get("nextAt"))
        || !matches!(r.get("events"), V::Array(_))
        || r.get("events").array().len() > 20
        || !matches!(r.get("buckets"), V::Array(_))
        || r.get("buckets").array().len() > 18
        || !r.get("cursor").truth()
        || !positive(r.get("cursor").get("minute"))
        || !positive(r.get("cursor").get("day"))
        || !r.get("cursor").get("rows").truth()
        || r.get("cursor").get("rows").entries().len() > 100
    {
        return false;
    }
    let plan = |p: &V| {
        matches!(p, V::Null)
            || p.truth()
                && matches!(p.get("patterns"), V::Array(_))
                && p.get("patterns").array().len() <= 8
                && p.get("patterns")
                    .array()
                    .iter()
                    .all(|k| ["local", "short", "express", "direct", "cross"].contains(&k.text()))
                && (matches!(p.get("fares"), V::Null)
                    || (matches!(p.get("fares"), V::Array(_))
                        && p.get("fares").array().len() == crate::tariffs::LIMITS.len()
                        && p.get("fares")
                            .array()
                            .iter()
                            .all(|f| positive(f) && f.n() <= crate::tariffs::MAX_PRICE)))
                && integer(p.get("stations"))
                && p.num("stations") >= 2.0
                && p.num("stations") <= 60.0
                && positive(p.get("open"))
                && positive(p.get("close"))
                && p.num("open") < p.num("close")
                && p.num("close") <= 1440.0
                && p.get("dispatch").truth()
                && ["manual", "auto"].contains(&p.get("dispatch").get("mode").text())
                && ["manual", "offPeak", "peak"]
                    .iter()
                    .all(|k| positive(p.get("dispatch").get(k)) && p.get("dispatch").num(k) <= 80.0)
    };
    let row = |v: &V| v.truth() && FIELDS.iter().all(|k| positive(v.get(k)));
    let id =
        |v: &str| v.starts_with('s') && v.len() > 1 && v[1..].bytes().all(|c| c.is_ascii_digit());
    if !r
        .get("cursor")
        .get("rows")
        .entries()
        .iter()
        .all(|r| row(&r.1))
    {
        return false;
    }
    for b in r.get("buckets").array() {
        if !positive(b.get("from"))
            || !positive(b.get("to"))
            || b.num("to") <= b.num("from")
            || b.num("to") - b.num("from") > 5.2
            || !b.get("rows").truth()
            || b.get("rows").entries().len() > 100
            || b.get("rows").entries().iter().any(|(k, v)| {
                !id(k)
                    || !row(v)
                    || !positive(v.get("grant"))
                    || !matches!(v.get("open"), V::Bool(_))
                    || !(matches!(v.get("load"), V::Null) || positive(v.get("load")))
                    || !(matches!(v.get("quality"), V::Null) || positive(v.get("quality")))
            })
        {
            return false;
        }
    }
    let mut ids = vec![];
    for e in r.get("events").array() {
        if ids.iter().any(|v| same(v, e.get("id"))) {
            return false;
        }
        ids.push(e.get("id").clone());
        if !integer(e.get("id"))
            || e.num("id") <= 0.0
            || e.num("id") >= r.num("nextId")
            || !id(e.get("line").text())
            || !matches!(e.get("name"), V::String(_))
            || len(e.get("name")) > 80
            || !matches!(e.get("kinds"), V::Array(_))
            || e.get("kinds").array().len() > 8
            || e.get("kinds")
                .array()
                .iter()
                .any(|v| !matches!(v, V::String(_)) || len(v) >= 30)
            || !positive(e.get("minute"))
            || !plan(e.get("beforePlan"))
            || !plan(e.get("afterPlan"))
            || (e.get("reason").truth()
                && (!matches!(e.get("reason"), V::String(_)) || len(e.get("reason")) > 120))
            || !positive(e.get("before").get("from"))
            || !positive(e.get("before").get("to"))
            || !aggregate(e.get("before"))
            || !aggregate(e.get("after"))
            || !positive(e.get("target"))
            || e.num("target") > 60.2
            || ![
                "pending",
                "warming",
                "observing",
                "complete",
                "interrupted",
                "deleted",
            ]
            .contains(&e.get("status").text())
            || ["warmUntil", "afterFrom", "until", "afterTo", "readyAt"]
                .iter()
                .any(|k| !matches!(e.get(k), V::Missing) && !positive(e.get(k)))
            || !e.get("environmentBefore").truth()
            || !["people", "jobs"]
                .iter()
                .all(|k| positive(e.get("environmentBefore").get(k)))
            || (e.get("environmentAfter").truth()
                && !["people", "jobs"]
                    .iter()
                    .all(|k| positive(e.get("environmentAfter").get(k))))
        {
            return false;
        }
    }
    true
}
pub(super) fn run(input: &V, cfg: &V) -> V {
    let mut s = input.get("state").clone();
    let rt = input.get("runtime");
    let a = input.get("args");
    let op = input.get("op").text();
    let result = match op {
        "reviewValid" => return boolean(valid(&s)),
        "reviewRates" => return rates(a.get("value")),
        "reviewView" => return view(a.get("event")),
        "reviewInit" => {
            if !valid(&s) {
                del(&mut s, "operationsReview");
            }
            if !s.get("operationsReview").truth() {
                s.set(
                    "operationsReview",
                    obj(&[
                        ("version", n(1.0)),
                        ("nextId", n(1.0)),
                        ("revision", n(0.0)),
                        ("events", arr(vec![])),
                        ("buckets", arr(vec![])),
                        ("cursor", cursor(&s, rt.num("minute"))),
                        ("nextAt", n(rt.num("minute") + 5.0)),
                    ]),
                );
            }
            V::Missing
        }
        "reviewSample" => boolean(sample(&mut s, rt, a.get("force").truth(), cfg)),
        "reviewPrepare" => prepare(&mut s, rt, cfg),
        "reviewRecord" => record(&mut s, rt, a.get("mark")),
        "reviewObserve" => observe(&mut s, rt, a.get("id"), cfg),
        "reviewReady" => {
            if s.get("operationsReview").truth() {
                ready(&mut s, a.num("minute"));
            }
            V::Missing
        }
        _ => panic!("unknown diagnostic operation"),
    };
    obj(&[
        ("result", result),
        ("review", s.get("operationsReview").clone()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gaps_interrupt_observation_without_inventing_measurements() {
        let mut s = obj(&[
            ("services", arr(vec![])),
            (
                "operationsReview",
                obj(&[
                    ("cursor", obj(&[("minute", n(480.0))])),
                    ("nextAt", n(485.0)),
                    ("revision", n(0.0)),
                    ("events", arr(vec![obj(&[("status", text("observing"))])])),
                    ("buckets", arr(vec![obj(&[])])),
                ]),
            ),
        ]);
        assert!(sample(
            &mut s,
            &obj(&[("minute", n(540.0))]),
            false,
            &obj(&[])
        ));
        let r = s.get("operationsReview");
        assert_eq!(
            r.get("events").array()[0].get("status").text(),
            "interrupted"
        );
        assert!(r.get("buckets").array().is_empty());
        assert_eq!(r.num("nextAt"), 545.0);
    }
}
