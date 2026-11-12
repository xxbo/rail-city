//! Native forecast aggregation, operational capacity, evidence and alarm decisions.
use crate::{
    editor as E,
    editor_support::*,
    queues::Read,
    value::{self, Value as V},
    CORE,
};
use std::cell::RefCell;
thread_local! {static FORECAST:RefCell<Option<(u32,V,Vec<Flow>)>>=const{RefCell::new(None)};}
pub(super) fn add(v: &mut V, k: &str, x: f64) {
    v.set(k, n(v.zero(k) + x));
}
pub(super) fn fallback_value<'a>(v: &'a V, d: &'a V) -> &'a V {
    if matches!(v, V::Missing | V::Null) {
        d
    } else {
        v
    }
}
pub(super) fn km(s: &V, l: &V) -> f64 {
    l.get("trackIds").array().iter().fold(0.0, |a, id| {
        a + crate::editor_geometry::track(s, id)
            .unwrap_or(&V::Missing)
            .num("km")
    })
}
fn effective(s: &V, l: &V) -> f64 {
    if s.num("routeModel") == 9.0 {
        return headway(s, l).unwrap();
    }
    if !l.get("fleet").truth() {
        return l.num("headway");
    }
    let cycle = l.get("trackIds").array().iter().fold(0.0, |v, id| {
        v + crate::editor_geometry::track(s, id).unwrap().num("km") / 48.0 * 60.0 + 0.6
    }) + 1.0;
    max(l.num("headway"), 2.0 * cycle / l.num("fleet"))
}
fn capacity(l: &V, cfg: &V) -> f64 {
    if l.get("fleetManaged").truth() {
        cfg.get("specs")
            .get(l.get("stockSpec").text())
            .num("capacity")
    } else {
        (if l.get("cars").truth() {
            l.num("cars")
        } else {
            8.0
        }) * 100.0
    }
}
pub(super) fn patterns(l: &V) -> V {
    if l.get("patterns").truth() {
        l.get("patterns").clone()
    } else {
        arr(vec![obj(&[
            ("kind", text("local")),
            ("from", n(0.0)),
            ("to", n(l.get("stops").array().len() as f64 - 1.0)),
            ("calls", arr(unique(l.get("stops").array()))),
            ("fleet", l.get("fleet").clone()),
            ("headway", l.get("headway").clone()),
        ])])
    }
}
pub(super) fn json(v:&V)->String{
    crate::json_codec::encode(v).expect("native diagnostic JSON exceeds codec limits")
}

fn sig(l: &V) -> V {
    text(&json(&arr(["dispatch", "patterns", "stops", "trackIds"]
        .iter()
        .map(|k| l.get(k).clone())
        .collect())))
}
pub(super) fn factor(s: &V, ids: &[V], hub: bool) -> f64 {
    let q = s.get("ridership");
    if !q.truth() || ids.is_empty() {
        return 1.0;
    }
    ids.iter().fold(f64::INFINITY, |a, id| {
        let l = q.get("lines").get(id.text());
        let f = if !l.truth() {
            1.0
        } else if q.num("model") == 22.0 {
            0.25 + 0.75 * max(0.0, min(1.0, fallback(l.get("satisfaction"), 0.7)))
        } else {
            let aw = if hub {
                1.0 - (1.0 - l.num("awareness")) * 0.5
            } else {
                l.num("awareness")
            };
            max(0.0, min(1.0, aw * l.num("trust")))
        };
        min(a, f)
    })
}
fn stats_row(l: &V) -> V {
    obj(&[
        ("riders", n(0.0)),
        ("revenue", n(0.0)),
        (
            "stations",
            V::Object(
                unique(l.get("stops").array())
                    .iter()
                    .map(|id| (jsstring(id), obj(&[("board", n(0.0)), ("alight", n(0.0))])))
                    .collect(),
            ),
        ),
    ])
}
pub(super) struct Flow {
    pub from: f64,
    pub trips: f64,
    pub demand: f64,
    pub distance: f64,
    pub fare: f64,
    pub transfers: f64,
    pub hub: bool,
    pub ids: Vec<usize>,
    pub fares: Vec<(usize, f64)>,
    pub edges: Vec<usize>,
}
fn flows(meta: &V, data: &[f64], mut f: impl FnMut(Flow)) {
    let mut at = 0;
    let mut take = || {
        let v = data[at];
        at += 1;
        v
    };
    for _ in 0..meta.num("count") as usize {
        if meta.get("compact").truth() {
            let h = (0..24).map(|_| take()).collect::<Vec<_>>();
            let edges = (0..h[23] as usize).map(|_| take() as usize).collect();
            let fares = (0..take() as usize)
                .map(|_| {
                    let id = take() as usize;
                    (id, take())
                })
                .collect::<Vec<_>>();
            f(Flow {
                from: h[0],
                trips: h[4],
                demand: h[5],
                distance: h[21],
                fare: h[20],
                transfers: h[22],
                hub: h[10] >= 0.0,
                ids: fares.iter().map(|r| r.0.clone()).collect(),
                fares,
                edges,
            });
        } else {
            let from = take();
            let trips = take();
            let demand = take();
            let distance = take();
            let transfers = take();
            let hub = take() != 0.0;
            let fare = take();
            let count = take();
            let ids = if count < 0.0 {
                None
            } else {
                Some((0..count as usize).map(|_| take() as usize).collect())
            };
            let fares = (0..take() as usize)
                .map(|_| {
                    let id = take() as usize;
                    (id, take())
                })
                .collect::<Vec<_>>();
            let edges = (0..take() as usize).map(|_| take() as usize).collect();
            f(Flow {
                from,
                trips,
                demand,
                distance,
                fare,
                transfers,
                hub,
                ids: ids.unwrap_or_else(|| fares.iter().map(|r| r.0.clone()).collect()),
                fares,
                edges,
            });
        }
    }
}
fn finish(s: &V, l: &V, total: &V, op: &V, cfg: &V) -> V {
    let runs = op
        .get("services")
        .array()
        .iter()
        .filter(|r| eq(r.get("parentLine"), l.get("id")))
        .collect::<Vec<_>>();
    let length = km(s, l);
    let hours = (l.num("close") - l.num("open")) / 60.0;
    let departures = runs.iter().fold(0.0, |v, r| {
        v + hours * 60.0 / headway(s, r).unwrap() * dirs(r).len() as f64
    });
    let vehicle = runs.iter().fold(0.0, |v, r| {
        v + km(s, r) * hours * 60.0 / headway(s, r).unwrap()
            * dirs(r).len() as f64
            * (180.0 + r.num("cars") * 25.0)
    });
    let cost = vehicle
        + if l.get("fleetManaged").truth() {
            planned(l, minute(s))
        } else {
            l.num("fleet")
        } * 18000.0
        + length * 2200.0;
    let revenue = total.num("revenue");
    let balance = cfg.get("balance");
    obj(&[
        ("riders", total.get("riders").clone()),
        ("revenue", n(revenue)),
        ("operatingGrant", n(revenue * balance.num("GRANT_RATE"))),
        (
            "totalIncome",
            n(revenue * (1.0 + balance.num("GRANT_RATE"))),
        ),
        ("cost", n(cost * balance.num("OPERATING_FACTOR"))),
        ("km", n(length)),
        (
            "headway",
            n(if runs.is_empty() {
                l.num("headway")
            } else {
                1.0 / runs
                    .iter()
                    .fold(0.0, |v, r| v + 1.0 / headway(s, r).unwrap())
            }),
        ),
        ("stations", total.get("stations").clone()),
        ("capacity", n(capacity(l, cfg))),
        ("fleet", l.get("fleet").clone()),
        ("cars", l.get("cars").clone()),
        ("hours", n(hours)),
        ("departures", n(departures)),
    ])
}
pub(super) fn physical(s: &V, r: &V, track: &V, dir: f64) -> f64 {
    let i = pos(r.get("trackIds").array(), track);
    if let Some(i) = i {
        if let Some(t) = crate::editor_geometry::track(s, track) {
            if !eq(&r.get("stops").array()[i], t.get("a")) {
                return -dir;
            }
        }
    }
    dir
}
pub(super) fn track_key(id: &V, dir: f64) -> String {
    format!("{}:{}", jsstring(id), jsstring(&n(dir)))
}
fn cap(s: &V, l: &V, op: &V, cfg: &V) -> V {
    let mut out = obj(&[]);
    for r in op
        .get("services")
        .array()
        .iter()
        .filter(|r| eq(r.get("parentLine"), l.get("id")))
    {
        let flow = capacity(r, cfg) * 60.0 / headway(op, r).unwrap();
        for id in r.get("trackIds").array() {
            for dir in dirs(r) {
                add(&mut out, &track_key(id, physical(s, r, id, dir)), flow);
            }
        }
    }
    out
}
fn ratio(d: &V, c: &V, share: f64) -> f64 {
    d.entries().iter().fold(0.0, |v, (k, n)| {
        if n.n() > 0.0 {
            max(
                v,
                if c.zero(k) != 0.0 {
                    n.n() * share / c.zero(k)
                } else {
                    f64::INFINITY
                },
            )
        } else {
            v
        }
    })
}
fn resize(ps: &V, total: f64) -> V {
    let len = ps.array().len();
    let minimum = len as f64 * 2.0;
    if total < minimum {
        return V::Null;
    }
    let mut out = crate::diagnostics::clone_json(ps);
    let sum = out.array().iter().fold(0.0, |v, p| v + p.num("fleet"));
    let shares = out
        .array()
        .iter()
        .map(|p| (total - minimum) * p.num("fleet") / max(1.0, sum) / 2.0)
        .collect::<Vec<_>>();
    let mut extras = shares.iter().map(|v| v.floor()).collect::<Vec<_>>();
    let rest = (total - minimum) / 2.0 - extras.iter().sum::<f64>();
    let mut order = (0..len).collect::<Vec<_>>();
    order.sort_by(|&a, &b| {
        (shares[b] - extras[b])
            .partial_cmp(&(shares[a] - extras[a]))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });
    for i in 0..rest.ceil().max(0.0) as usize {
        extras[order[i]] += 1.0;
    }
    for (i, p) in out.array_mut().iter_mut().enumerate() {
        p.set("fleet", n(2.0 + extras[i] * 2.0));
    }
    out
}
fn dispatch(l: &V, off: f64, peak: f64) -> V {
    let mut v = obj(&[(
        "dispatch",
        obj(&[
            ("mode", text("auto")),
            ("manual", l.get("dispatch").get("manual").clone()),
            ("offPeak", n(off)),
            ("peak", n(peak)),
        ]),
    )]);
    if l.get("patterns").truth() {
        let p = resize(l.get("patterns"), max(off, peak));
        if matches!(p, V::Null) {
            return V::Null;
        }
        v.set("patterns", p);
    }
    v
}
fn append(ps: &V, l: &V, before_off: f64, before_peak: f64, mut p: V) -> V {
    if ps.array().len() >= 8 || min(before_off, before_peak) < (ps.array().len() + 1) as f64 * 2.0 {
        return V::Null;
    }
    let mut out = crate::diagnostics::clone_json(ps);
    if !crate::line_planning::donate_pair(out.array_mut()) { return V::Null; }
    p.set("fleet", n(2.0));
    p.set("headway", l.get("headway").clone());
    out.array_mut().push(p);
    out
}
fn suggestion(
    out: &mut Vec<V>,
    l: &V,
    kind: &str,
    priority: f64,
    args: Vec<V>,
    extra: &[(&'static str, V)],
) {
    let mut v = obj(&[
        ("key", text(&format!("{}:{kind}", l.get("id").text()))),
        ("type", text(kind)),
        ("args", arr(args)),
        ("priority", n(priority)),
    ]);
    for (k, x) in extra {
        v.set(k, x.clone());
    }
    out.push(v);
}
fn rows(s: &V, rt: &V, op: &V, totals: &V, details: &V, cfg: &V) -> V {
    let peak_op = expanded(s, 480.0).unwrap();
    let off_op = expanded(s, 720.0).unwrap();
    let minute = fallback(rt.get("minute"), s.get("economy").num("minute"));
    let mut result = vec![];
    for l in s.get("services").array() {
        let id = l.get("id").text();
        let d = details.get(id);
        let stats = totals.get(id);
        let looped = eq(first(l.get("stops").array()), last(l.get("stops").array()));
        let ps = patterns(l);
        let demand = d.get("demand");
        let peak_load = ratio(demand, &cap(s, l, &peak_op, cfg), 0.18);
        let off_load = ratio(demand, &cap(s, l, &off_op, cfg), 0.06);
        let dispatch_before = l.get("dispatch");
        let auto = dispatch_before.get("mode").text() == "auto";
        let before_peak = dispatch_before.num(if auto { "peak" } else { "manual" });
        let before_off = dispatch_before.num(if auto { "offPeak" } else { "manual" });
        let minimum = ps.array().len() as f64 * 2.0;
        let duration = duration(s, l).unwrap();
        let cycle = if looped {
            duration * dirs(l).len() as f64
        } else {
            2.0 * (duration + 1.0)
        };
        let max_demand = demand.entries().iter().fold(0.0, |v, r| max(v, r.1.n()));
        let desired = |share: f64, interval: f64| {
            min(
                80.0,
                max(
                    minimum,
                    (cycle
                        * max(
                            60.0 / interval,
                            max_demand * share / (capacity(l, cfg) * 0.8),
                        )
                        / 60.0
                        / 2.0)
                        .ceil()
                        * 2.0,
                ),
            )
        };
        let ideal_peak = desired(0.18, 8.0);
        let ideal_off = min(ideal_peak, desired(0.06, 12.0));
        let available = max(
            0.0,
            min(
                80.0,
                ((s.get("depot").get("stock").zero(l.get("stockSpec").text())
                    - E::reserved(s, l.get("stockSpec"), l.get("id")))
                    / 2.0)
                    .floor()
                    * 2.0,
            ),
        );
        let target_peak = if available < minimum {
            0.0
        } else {
            min(ideal_peak, available)
        };
        let target_off = if available < minimum {
            0.0
        } else {
            min(ideal_off, available)
        };
        let trains = rt
            .get("trains")
            .array()
            .iter()
            .filter(|t| {
                eq(
                    if t.get("parentLine").truth() {
                        t.get("parentLine")
                    } else {
                        t.get("service")
                    },
                    l.get("id"),
                )
            })
            .collect::<Vec<_>>();
        let max_load = trains.iter().fold(0.0, |v, t| {
            max(v, t.num("onboard") / max(1.0, t.num("capacity")))
        });
        let mean_load = if trains.is_empty() {
            V::Null
        } else {
            n(trains
                .iter()
                .fold(0.0, |v, t| v + t.num("onboard") / t.num("capacity"))
                / trains.len() as f64)
        };
        let queues = if rt.get("nativeView").get("queues").truth() {
            rt.get("nativeView").get("queues")
        } else {
            rt.get("queues")
        };
        let outside_data = if rt.get("nativeView").get("outside").truth() {
            rt.get("nativeView").get("outside")
        } else {
            rt.get("outside")
        };
        let waiting = queues
            .entries()
            .iter()
            .filter(|(k, _)| {
                let run = k.split('|').next().unwrap_or("");
                let r = op
                    .get("services")
                    .array()
                    .iter()
                    .find(|r| r.get("id").text() == run);
                r.map_or(run, |r| r.get("parentLine").text()) == id
            })
            .fold(0.0, |v, (_, q)| {
                v + q.entries().iter().fold(0.0, |a, r| a + r.1.n())
            });
        let outside = unique(l.get("stops").array()).iter().fold(0.0, |v, id| {
            v + outside_data
                .get(&jsstring(id))
                .entries()
                .iter()
                .fold(0.0, |a, r| a + r.1.n())
        });
        let opened = minute % 1440.0 >= l.num("open") && minute % 1440.0 < l.num("close");
        let evidence = !demand.entries().is_empty();
        let satisfaction = s.get("ridership").get("lines").get(id).get("satisfaction");
        let mut suggestions = vec![];
        if evidence && (ideal_peak > before_peak || ideal_off > before_off) {
            suggestion(
                &mut suggestions,
                l,
                "add",
                if peak_load > 1.0 { 95.0 } else { 72.0 },
                vec![
                    n(max_demand * 0.18),
                    n(before_peak),
                    n(ideal_peak),
                    n(before_off),
                    n(ideal_off),
                ],
                &[("action", text("dispatch"))],
            );
        }
        if evidence
            && ((before_off > ideal_off && off_load < 0.45)
                || (before_peak > ideal_peak && peak_load < 0.45))
            && !(opened && max_load > 0.85 && waiting > 0.0)
        {
            suggestion(
                &mut suggestions,
                l,
                "reduce",
                55.0,
                vec![
                    n(peak_load * 100.0),
                    n(off_load * 100.0),
                    n(before_off),
                    n(ideal_off),
                    n(before_peak),
                    n(ideal_peak),
                ],
                &[("action", text("dispatch"))],
            );
        }
        if opened && waiting > 0.0 && max_load >= 0.9 {
            suggestion(
                &mut suggestions,
                l,
                "crowd",
                100.0,
                vec![n(max_load * 100.0), n(waiting)],
                &[("action", text("review"))],
            );
        }
        if opened && outside > 0.0 {
            suggestion(
                &mut suggestions,
                l,
                "station",
                85.0,
                vec![n(outside)],
                &[("action", text("review"))],
            );
        }
        if ideal_peak > available && evidence {
            suggestion(
                &mut suggestions,
                l,
                "stock",
                82.0,
                vec![
                    l.get("stockSpec").clone(),
                    n(available),
                    n(ideal_peak),
                    n(ideal_peak - available),
                ],
                &[("action", text("buy")), ("qty", n(ideal_peak - available))],
            );
        }
        let mut seen = vec![];
        let mut removal = false;
        for (i, p) in ps.array().iter().enumerate() {
            let key = json(&arr(["kind", "from", "to", "calls", "target", "targetEnd"]
                .iter()
                .map(|k| p.get(k).clone())
                .collect()));
            if let Some((_, at)) = seen.iter().find(|r: &&(String, usize)| r.0 == key) {
                if !removal {
                    let mut next = crate::diagnostics::clone_json(&ps);
                    next.array_mut().remove(i);
                    let sum = next.array().iter().fold(0.0, |v, p| v + p.num("fleet"));
                    let first = &mut next.array_mut()[0];
                    first.set(
                        "fleet",
                        n(first.num("fleet") + max(0.0, l.num("fleet") - sum)),
                    );
                    suggestion(
                        &mut suggestions,
                        l,
                        "duplicate",
                        64.0,
                        vec![n(i as f64 + 1.0), n(*at as f64 + 1.0)],
                        &[("action", text("pattern")), ("patterns", next)],
                    );
                    removal = true;
                }
            }
            if let Some(r) = seen.iter_mut().find(|r| r.0 == key) {
                r.1 = i;
            } else {
                seen.push((key, i));
            }
        }
        let run_usage = op
            .get("services")
            .array()
            .iter()
            .filter(|r| eq(r.get("parentLine"), l.get("id")))
            .map(|r| (r, d.get("usage").zero(r.get("id").text())))
            .collect::<Vec<_>>();
        let usage_total = run_usage.iter().fold(0.0, |v, r| v + r.1);
        if !removal && ps.array().len() > 1 && usage_total > 1000.0 {
            if let Some(full) = ps.array().iter().position(|p| {
                p.get("kind").text() == "local"
                    && p.num("from") == 0.0
                    && p.num("to") == l.get("stops").array().len() as f64 - 1.0
            }) {
                if let Some((run, amount)) = run_usage.iter().find(|(r, a)| {
                    r.num("patternIndex") != full as f64
                        && ps.array()[r.num("patternIndex") as usize]
                            .get("kind")
                            .text()
                            != "cross"
                        && a / usage_total < 0.05
                }) {
                    let ix = run.num("patternIndex") as usize;
                    let mut next = crate::diagnostics::clone_json(&ps);
                    next.array_mut().remove(ix);
                    let p = &mut next.array_mut()[if full > ix { full - 1 } else { full }];
                    p.set("fleet", n(p.num("fleet") + ps.array()[ix].num("fleet")));
                    suggestion(
                        &mut suggestions,
                        l,
                        "low-pattern",
                        48.0,
                        vec![n(ix as f64 + 1.0), n(amount / usage_total * 100.0)],
                        &[("action", text("pattern")), ("patterns", next)],
                    );
                }
            }
        }
        let segments = l
            .get("trackIds")
            .array()
            .iter()
            .enumerate()
            .map(|(i, id)| {
                obj(&[
                    ("id", id.clone()),
                    ("i", n(i as f64)),
                    ("from", l.get("stops").array()[i].clone()),
                    ("to", l.get("stops").array()[i + 1].clone()),
                    (
                        "demand",
                        n(max(
                            demand.zero(&track_key(id, 1.0)),
                            demand.zero(&track_key(id, -1.0)),
                        )),
                    ),
                ])
            })
            .collect::<Vec<_>>();
        let top = segments.iter().fold(0.0, |v, s| max(v, s.num("demand")));
        let hot = segments
            .iter()
            .filter(|v| v.num("demand") >= top * 0.65 && v.num("demand") > 0.0)
            .collect::<Vec<_>>();
        if !looped
            && segments.len() >= 5
            && !hot.is_empty()
            && hot.last().unwrap().num("i") - hot[0].num("i") + 1.0 <= segments.len() as f64 * 0.7
            && peak_load > 0.75
            && !ps.array().iter().any(|p| p.get("kind").text() == "short")
        {
            let first = hot[0].num("i") as usize;
            let last = hot.last().unwrap().num("i") as usize;
            let draft = append(
                &ps,
                l,
                before_off,
                before_peak,
                obj(&[
                    ("kind", text("short")),
                    ("from", n(first as f64)),
                    ("to", n(last as f64 + 1.0)),
                ]),
            );
            suggestion(
                &mut suggestions,
                l,
                "short",
                67.0,
                vec![
                    s.get("nodes").array()[l.get("stops").array()[first].n() as usize]
                        .get("name")
                        .clone(),
                    s.get("nodes").array()[l.get("stops").array()[last + 1].n() as usize]
                        .get("name")
                        .clone(),
                ],
                &[
                    (
                        "action",
                        text(if draft.truth() { "pattern" } else { "review" }),
                    ),
                    ("patterns", draft),
                ],
            );
        }
        if !looped
            && stats.num("km") >= 20.0
            && l.get("stops").array().len() >= 8
            && d.num("riders") > 1000.0
            && d.num("long") / d.num("riders") >= 0.35
            && !ps
                .array()
                .iter()
                .any(|p| ["express", "direct"].contains(&p.get("kind").text()))
        {
            let mut ranked = unique(l.get("stops").array());
            ranked.sort_by(|a, b| {
                let rank = |id: &V| {
                    let st = stats.get("stations").get(&jsstring(id));
                    st.zero("board") + st.zero("alight")
                };
                rank(b)
                    .partial_cmp(&rank(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut calls = vec![
                first(l.get("stops").array()).clone(),
                last(l.get("stops").array()).clone(),
            ];
            calls.extend(
                ranked
                    .into_iter()
                    .take(4.min(l.get("stops").array().len() / 2)),
            );
            let draft = append(
                &ps,
                l,
                before_off,
                before_peak,
                obj(&[
                    ("kind", text("express")),
                    ("from", n(0.0)),
                    ("to", n(l.get("stops").array().len() as f64 - 1.0)),
                    ("calls", arr(unique(&calls))),
                ]),
            );
            suggestion(
                &mut suggestions,
                l,
                "express",
                50.0,
                vec![n(d.num("long") / d.num("riders") * 100.0)],
                &[
                    (
                        "action",
                        text(if draft.truth() { "pattern" } else { "review" }),
                    ),
                    ("patterns", draft),
                ],
            );
        }
        if !evidence {
            suggestion(
                &mut suggestions,
                l,
                "observe",
                30.0,
                vec![],
                &[("action", text("review"))],
            );
        }
        if satisfaction.n() < 0.6 {
            suggestion(
                &mut suggestions,
                l,
                "quality",
                60.0,
                vec![n(satisfaction.n() * 100.0)],
                &[("action", text("review"))],
            );
        }
        suggestions.sort_by(|a, b| {
            b.num("priority")
                .partial_cmp(&a.num("priority"))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        result.push(obj(&[
            ("id", l.get("id").clone()),
            ("l", l.clone()),
            ("stats", stats.clone()),
            (
                "priority",
                n(suggestions.first().map_or(0.0, |v| v.num("priority"))),
            ),
            ("suggestions", arr(suggestions)),
            ("demand", boolean(evidence)),
            (
                "sectionDemand",
                arr(demand
                    .entries()
                    .iter()
                    .map(|(k, v)| arr(vec![text(k), v.clone()]))
                    .collect()),
            ),
            ("maxDemand", n(max_demand)),
            ("peakLoad", n(peak_load)),
            ("offLoad", n(off_load)),
            ("segments", arr(segments)),
            (
                "runUsage",
                arr(run_usage
                    .iter()
                    .map(|(r, a)| {
                        obj(&[
                            ("id", r.get("id").clone()),
                            ("kind", r.get("patternKind").clone()),
                            (
                                "share",
                                n(if usage_total != 0.0 {
                                    a / usage_total
                                } else {
                                    0.0
                                }),
                            ),
                        ])
                    })
                    .collect()),
            ),
            ("beforePeak", n(before_peak)),
            ("beforeOff", n(before_off)),
            ("idealPeak", n(ideal_peak)),
            ("idealOff", n(ideal_off)),
            ("targetPeak", n(target_peak)),
            ("targetOff", n(target_off)),
            ("available", n(available)),
            ("shortage", n(max(0.0, ideal_peak - available))),
            ("dispatch", dispatch(l, target_off, target_peak)),
            ("online", n(trains.len() as f64)),
            ("maxLoad", n(max_load)),
            ("meanLoad", mean_load),
            ("waiting", n(waiting)),
            ("outside", n(outside)),
            ("open", boolean(opened)),
            (
                "satisfaction",
                fallback_value(satisfaction, &V::Null).clone(),
            ),
            ("signature", sig(l)),
        ]));
    }
    result.sort_by(|a, b| {
        (b.num("priority") - a.num("priority"))
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.get("stats")
                    .num("riders")
                    .partial_cmp(&a.get("stats").num("riders"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    arr(result)
}
fn legacy_traffic(l: &V, graph: &V, data: &[Flow]) -> V {
    let mut out = stats_row(l);
    let time = (l.num("close") - l.num("open")) / (18.0 * 60.0);
    data.iter().for_each(|f| {
        let mut from = n(f.from);
        let mut length = 0.0;
        let mut aboard = false;
        let mut used = false;
        for (i, &ix) in f.edges.iter().enumerate() {
            let e = &graph.get("edges").array()[ix];
            if eq(e.get("service"), l.get("id")) {
                if !aboard {
                    add(
                        out.get_mut("stations").get_mut(&jsstring(&from)),
                        "board",
                        f.trips * time,
                    );
                    add(&mut out, "riders", f.trips * time);
                    aboard = true;
                }
                length += e.num("km");
                used = true;
                if f.edges.get(i + 1).map_or(true, |&j| {
                    !eq(graph.get("edges").array()[j].get("service"), l.get("id"))
                }) {
                    add(
                        out.get_mut("stations").get_mut(&jsstring(e.get("to"))),
                        "alight",
                        f.trips * time,
                    );
                    aboard = false;
                }
            }
            from = e.get("to").clone();
        }
        if used {
            add(
                &mut out,
                "revenue",
                f.trips * f.fare * length / f.distance * time,
            );
        }
    });
    out
}

// Use the same boarding counts as the line panel, without constructing its
// income, operating cost and frequency projections for every service.
pub(super) fn line_riders(world: &V, line: &V, meta: &V, data: &[Flow]) -> Result<f64, String> {
    if world.num("routeModel") != 9.0 {
        return Ok(legacy_traffic(line, meta.get("graph"), data).num("riders"));
    }
    let plan = expanded(world, minute(world))?;
    let totals = crate::diagnostic_aggregate::aggregate(world, &plan, meta, data, false, false).totals;
    Ok(totals.get(line.get("id").text()).num("riders"))
}

fn aggregate(s: &V, rt: &V, meta: &V, data: &[Flow], cfg: &V, operation: &str, view: &V) -> V {
    let now = fallback(rt.get("minute"), minute(s));
    let op = expanded(
        s,
        if operation == "analyze" || operation == "diagnose" {
            now
        } else {
            minute(s)
        },
    )
    .unwrap();
    let graph = meta.get("graph");
    let crate::diagnostic_aggregate::Aggregation {
        mut totals,
        details,
        journeys,
        passenger_km,
        transfer_trips,
    } = crate::diagnostic_aggregate::aggregate(
        s,
        &op,
        meta,
        data,
        operation == "analyze" || operation == "diagnose",
        operation == "metrics",
    );
    if operation == "metrics" {
        return metrics_result(s, journeys, passenger_km, transfer_trips, view);
    }
    let stats_op = expanded(s, minute(s)).unwrap();
    for l in s.get("services").array() {
        let total = totals.get(l.get("id").text()).clone();
        let stat = if s.num("routeModel") == 9.0 {
            finish(s, l, &total, &stats_op, cfg)
        } else {
            let out = legacy_traffic(l, graph, data);
            let length = km(s, l);
            let hw = effective(s, l);
            let hours = (l.num("close") - l.num("open")) / 60.0;
            let dep = hours * 60.0 / hw * 2.0;
            let revenue = out.num("revenue");
            obj(&[
                ("riders", out.get("riders").clone()),
                ("revenue", n(revenue)),
                (
                    "operatingGrant",
                    n(revenue * cfg.get("balance").num("GRANT_RATE")),
                ),
                (
                    "totalIncome",
                    n(revenue * (1.0 + cfg.get("balance").num("GRANT_RATE"))),
                ),
                (
                    "cost",
                    n((length * dep * (180.0 + l.num("cars") * 25.0)
                        + if l.get("fleetManaged").truth() {
                            planned(l, minute(s))
                        } else {
                            l.num("fleet")
                        } * 18000.0
                        + length * 2200.0)
                        * cfg.get("balance").num("OPERATING_FACTOR")),
                ),
                ("km", n(length)),
                ("headway", n(hw)),
                ("stations", out.get("stations").clone()),
                ("capacity", n(capacity(l, cfg))),
                ("fleet", l.get("fleet").clone()),
                ("cars", l.get("cars").clone()),
                ("hours", n(hours)),
                ("departures", n(dep)),
            ])
        };
        totals.set(l.get("id").text(), stat);
    }
    if operation == "analyze" || operation == "diagnose" {
        let rows = rows(s, rt, &op, &totals, &details, cfg);
        if operation == "diagnose" {
            obj(&[
                ("rows", rows),
                (
                    "metrics",
                    metrics_result(s, journeys, passenger_km, transfer_trips, view),
                ),
            ])
        } else {
            rows
        }
    } else {
        totals
    }
}
fn alerts(s: &V, rt: &V, cfg: &V) -> V {
    let plan = if rt.get("plan").truth() {
        rt.get("plan").clone()
    } else {
        expanded(s, minute(s)).unwrap()
    };
    let mut station_wait = obj(&[]);
    let mut line_wait = obj(&[]);
    let native = rt.get("nativeView");
    let queues = if native.get("queues").truth() {
        native.get("queues")
    } else {
        rt.get("queues")
    };
    for (key, q) in queues.entries() {
        let parts = key.split('|').collect::<Vec<_>>();
        let run = parts[0];
        let station = parts.get(2).copied().unwrap_or("undefined");
        let amount = q.entries().iter().fold(0.0, |v, r| v + r.1.n());
        let line = plan
            .get("services")
            .array()
            .iter()
            .find(|l| l.get("id").text() == run)
            .map_or(run, |l| {
                if l.get("parentLine").truth() {
                    l.get("parentLine").text()
                } else {
                    run
                }
            });
        add(&mut station_wait, station, amount);
        add(&mut line_wait, line, amount);
    }
    let transfers = if native.get("transfers").truth() {
        native.get("transfers")
    } else {
        rt.get("transfers")
    };
    for t in transfers.array() {
        add(
            &mut station_wait,
            &jsstring(t.get("station")),
            t.num("amount"),
        );
    }
    let outside = if native.get("outside").truth() {
        native.get("outside")
    } else {
        rt.get("outside")
    };
    let served = unique(
        &s.get("services")
            .array()
            .iter()
            .flat_map(|l| l.get("stops").array().to_vec())
            .collect::<Vec<_>>(),
    );
    let mut result = vec![];
    for id in served {
        let base = if s.get("baseLines").truth() {
            s.get("baseLines")
        } else {
            s.get("services")
        };
        let ls = base
            .array()
            .iter()
            .filter(|l| l.get("stops").array().iter().any(|x| eq(x, &id)))
            .collect::<Vec<_>>();
        let cars = ls.iter().fold(4.0, |v, l| {
            max(
                v,
                if l.get("cars").truth() {
                    l.num("cars")
                } else {
                    6.0
                },
            )
        });
        let platforms = max(2.0, min(6.0, ls.len() as f64 * 2.0));
        let length =
            ls.iter()
                .filter(|l| l.get("fleetManaged").truth())
                .fold(cars * 20.0 + 20.0, |v, l| {
                    max(
                        v,
                        cfg.get("specs")
                            .get(l.get("stockSpec").text())
                            .num("length")
                            + 20.0,
                    )
                });
        let capacity = (length * 3.0 * platforms / 0.93).floor();
        let inside = station_wait.zero(&jsstring(&id));
        let outside = outside
            .get(&jsstring(&id))
            .entries()
            .iter()
            .fold(0.0, |v, r| v + r.1.n());
        let ratio = inside / capacity;
        if ratio >= 0.85 || outside > 0.0 {
            result.push(obj(&[
                ("key", text(&format!("station:{}", jsstring(&id)))),
                ("type", text("station")),
                ("id", id.clone()),
                (
                    "level",
                    text(if ratio >= 0.95 || outside > capacity * 0.1 {
                        "critical"
                    } else {
                        "warning"
                    }),
                ),
                (
                    "name",
                    s.get("nodes").array()[id.n() as usize].get("name").clone(),
                ),
                (
                    "messageCode",
                    text(if outside > 0.0 { "outside" } else { "station" }),
                ),
                ("capacity", n(capacity)),
                ("ratio", n(ratio)),
                ("inside", n(inside)),
                ("outside", n(outside)),
            ]));
        }
    }
    for l in s.get("services").array() {
        let id = l.get("id");
        let max_load = rt
            .get("trains")
            .array()
            .iter()
            .filter(|t| {
                eq(
                    if t.get("parentLine").truth() {
                        t.get("parentLine")
                    } else {
                        t.get("service")
                    },
                    id,
                )
            })
            .fold(0.0, |v, t| max(v, t.num("onboard") / t.num("capacity")));
        let waiting = line_wait.zero(id.text());
        let per_minute = plan
            .get("services")
            .array()
            .iter()
            .filter(|r| {
                eq(
                    if r.get("parentLine").truth() {
                        r.get("parentLine")
                    } else {
                        r.get("id")
                    },
                    id,
                )
            })
            .fold(0.0, |v, r| {
                v + capacity(r, cfg) * dirs(r).len() as f64
                    / if plan.num("routeModel") == 9.0 {
                        headway(&plan, r).unwrap()
                    } else {
                        effective(&plan, r)
                    }
            });
        let clearance = if per_minute != 0.0 {
            waiting / per_minute
        } else if waiting != 0.0 {
            f64::INFINITY
        } else {
            0.0
        };
        let critical = clearance >= 20.0 || max_load >= 0.99 && waiting > 0.0;
        if clearance >= 10.0 || max_load >= 0.9 && waiting > 0.0 {
            result.push(obj(&[
                ("key", text(&format!("line:{}", id.text()))),
                ("type", text("line")),
                ("id", id.clone()),
                ("level", text(if critical { "critical" } else { "warning" })),
                ("name", l.get("name").clone()),
                (
                    "messageCode",
                    text(if per_minute == 0.0 {
                        "idle"
                    } else if clearance >= 10.0 {
                        "clearance"
                    } else {
                        "line"
                    }),
                ),
                ("ratio", n(max_load)),
                ("waiting", n(waiting)),
                ("clearance", n(clearance)),
            ]));
        }
    }
    result.sort_by(|a, b| {
        (b.get("level").text() == "critical")
            .cmp(&(a.get("level").text() == "critical"))
            .then_with(|| {
                b.num("ratio")
                    .partial_cmp(&a.num("ratio"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.get("key").text().cmp(b.get("key").text()))
    });
    arr(result)
}
fn run(input: &V, forecast: &V, data: &[Flow], cfg: &V) -> V {
    let s = input.get("state");
    let a = input.get("args");
    match input.get("op").text() {
        "stats" | "analyze" | "metrics" | "diagnose" => aggregate(
            s,
            input.get("runtime"),
            forecast,
            data,
            cfg,
            input.get("op").text(),
            input.get("forecastView"),
        ),
        "signature" => sig(a.get("line")),
        "resize" => resize(a.get("patterns"), a.num("total")),
        "dispatch" => dispatch(a.get("line"), a.num("offPeak"), a.num("peak")),
        "capacity" => {
            let op = if a.get("prepared").truth() {
                a.get("prepared").clone()
            } else {
                expanded(s, a.num("minute")).unwrap()
            };
            let c = cap(s, a.get("line"), &op, cfg);
            arr(c
                .entries()
                .iter()
                .map(|(k, v)| arr(vec![text(k), v.clone()]))
                .collect())
        }
        "ratio" => ratio(
            &V::Object(
                a.get("demand")
                    .array()
                    .iter()
                    .map(|r| (r.array()[0].text().into(), r.array()[1].clone()))
                    .collect(),
            ),
            &V::Object(
                a.get("capacity")
                    .array()
                    .iter()
                    .map(|r| (r.array()[0].text().into(), r.array()[1].clone()))
                    .collect(),
            ),
            a.num("share"),
        )
        .into(),
        "preview" => {
            let row = a.get("row");
            if row.get("shortage").truth()
                && eq(row.get("targetOff"), row.get("beforeOff"))
                && eq(row.get("targetPeak"), row.get("beforePeak"))
            {
                return obj(&[(
                    "error",
                    text("兼容库存只够维持当前投放，请先收回其他线路配属或购车，再审核加车方案。"),
                )]);
            }
            if !row.get("dispatch").truth() {
                return obj(&[("error", text("现有交路数量所需的最低配车不足。"))]);
            }
            let mut after = crate::diagnostics::clone_json(s);
            let args = obj(&[
                ("id", row.get("id").clone()),
                ("values", row.get("dispatch").clone()),
            ]);
            if let Err(e) = E::command(&mut after, "configure", &args, cfg) {
                return obj(&[("error", text(&e))]);
            }
            if !E::validate(&after, cfg) {
                return obj(&[("error", text("线路配置无效，操作未保存。"))]);
            }
            let line = &after.get("services").array()
                [index_id(after.get("services"), row.get("id")).unwrap()];
            let op = expanded(&after, 480.0).unwrap();
            let demand = V::Object(
                row.get("sectionDemand")
                    .array()
                    .iter()
                    .map(|r| (r.array()[0].text().into(), r.array()[1].clone()))
                    .collect(),
            );
            obj(&[
                ("values", row.get("dispatch").clone()),
                ("offPeak", row.get("targetOff").clone()),
                ("peak", row.get("targetPeak").clone()),
                (
                    "peakRatio",
                    n(ratio(&demand, &cap(&after, line, &op, cfg), 0.18)),
                ),
                ("signature", row.get("signature").clone()),
            ])
        }
        "alerts" => alerts(s, input.get("runtime"), cfg),
        _ => crate::diagnostic_review::run(input, cfg),
    }
}
impl From<f64> for V {
    fn from(v: f64) -> Self {
        V::Number(v)
    }
}
pub(super) fn decode_owned(meta:&V,data:&[f64])->Vec<Flow>{let mut decoded=vec![];flows(meta,data,|f|decoded.push(f));decoded}
pub(super) fn query_owned(input:&V,meta:&V,data:&[Flow])->V{run(input,meta,data,&crate::bootstrap::config())}
#[no_mangle]
pub extern "C" fn diagnostic_abi() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn diagnostic_token() -> u32 {
    FORECAST.with(|c| c.borrow().as_ref().map_or(0, |v| v.0))
}
#[no_mangle]
pub extern "C" fn diagnostic_run() -> *const f64 {
    CORE.with(|cell| {
        let mut c = cell.borrow_mut();
        let mut r = Read { v: &c.input, at: 0 };
        let length = r.u();
        let start = r.at;
        let input = value::read(&mut r);
        assert_eq!(r.at - start, length);
        let load = input.get("load").truth();
        if load {
            FORECAST.with(|cache| {
                *cache.borrow_mut() =
                    Some((input.num("token") as u32, input.get("forecast").clone(), {
                        let mut decoded = vec![];
                        flows(input.get("forecast"), &r.v[r.at..], |f| decoded.push(f));
                        decoded
                    }))
            });
        }
        let output = E::with_config(|cfg| {
            FORECAST.with(|cache| {
                let cache = cache.borrow();
                let (meta, data) = cache
                    .as_ref()
                    .map_or((&V::Missing, &[][..]), |v| (&v.1, v.2.as_slice()));
                run(&input, meta, data, cfg)
            })
        });
        c.output = value::write(&output);
        c.output.as_ptr()
    })
}

fn metrics_result(s: &V, journeys: f64, passenger_km: f64, transfer_trips: f64, view: &V) -> V {
    let track_ids = unique(
        &s.get("services")
            .array()
            .iter()
            .flat_map(|l| l.get("trackIds").array().to_vec())
            .collect::<Vec<_>>(),
    );
    let network_km = s
        .get("tracks")
        .array()
        .iter()
        .filter(|t| track_ids.iter().any(|id| same(id, t.get("id"))))
        .fold(0.0, |v, t| v + t.num("km"));
    let line_km = s.get("services").array().iter().fold(0.0, |v, l| {
        v + l.get("trackIds").array().iter().fold(0.0, |a, id| {
            a + crate::editor_geometry::track(s, id).map_or(0.0, |t| t.zero("km"))
        })
    });
    let mut stations = obj(&[]);
    for l in s.get("services").array() {
        for id in unique(l.get("stops").array()) {
            let ls = stations.get_mut(&jsstring(&id));
            if !ls.array().iter().any(|x| same(x, l.get("id"))) {
                ls.array_mut().push(l.get("id").clone());
            }
        }
    }
    return obj(&[
        ("networkKm", n(network_km)),
        ("lineKm", n(line_km)),
        ("stations", n(stations.entries().len() as f64)),
        (
            "interchanges",
            n(stations
                .entries()
                .iter()
                .filter(|r| r.1.array().len() > 1)
                .count() as f64),
        ),
        ("lines", n(s.get("services").array().len() as f64)),
        (
            "fleet",
            n(s.get("services")
                .array()
                .iter()
                .fold(0.0, |v, l| v + l.num("fleet"))),
        ),
        ("journeys", n(journeys)),
        ("passengerKm", n(passenger_km)),
        (
            "intensity",
            n(if network_km != 0.0 {
                journeys / network_km
            } else {
                0.0
            }),
        ),
        (
            "averageDistance",
            n(if journeys != 0.0 {
                passenger_km / journeys
            } else {
                0.0
            }),
        ),
        (
            "transferShare",
            n(if journeys != 0.0 {
                transfer_trips / journeys
            } else {
                0.0
            }),
        ),
        (
            "coverage",
            n(if view.get("population").truth() {
                view.num("covered") / view.num("population")
            } else {
                0.0
            }),
        ),
    ]);
}

pub(super) fn clone_json(v: &V) -> V {
    match v {
        V::Missing => V::Null,
        V::Number(x) if !x.is_finite() => V::Null,
        V::Number(x) if *x == 0.0 => n(0.0),
        V::Array(a) => arr(a.iter().map(clone_json).collect()),
        V::Object(a) => V::Object(
            a.iter()
                .filter(|r| !matches!(r.1, V::Missing))
                .map(|(k, v)| (k.clone(), clone_json(v)))
                .collect(),
        ),
        _ => v.clone(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_preserves_even_minimums_and_stable_ties() {
        let p = arr(vec![
            obj(&[("fleet", n(2.0))]),
            obj(&[("fleet", n(2.0))]),
            obj(&[("fleet", n(2.0))]),
        ]);
        assert!(matches!(resize(&p, 4.0), V::Null));
        let out = resize(&p, 10.0);
        assert_eq!(
            out.array()
                .iter()
                .map(|p| p.num("fleet"))
                .collect::<Vec<_>>(),
            vec![4.0, 4.0, 2.0]
        );
        assert_eq!(p.array()[0].num("fleet"), 2.0);
    }
    #[test]
    fn unmet_section_capacity_is_infinite_and_zero_demand_is_zero() {
        let d = obj(&[("t1:1", n(100.0))]);
        assert!(ratio(&d, &obj(&[]), 0.18).is_infinite());
        assert_eq!(ratio(&obj(&[]), &obj(&[]), 0.18), 0.0);
        assert_eq!(ratio(&d, &obj(&[("t1:1", n(20.0))]), 0.18), 0.9);
    }
}
