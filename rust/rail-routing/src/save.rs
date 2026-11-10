//! Versioned file acceptance and cold restore validation. Host owns JSON/files and object identity.
use crate::{editor as E, editor_support::*, value::Value as V};
use std::collections::HashSet;
fn object(v: &V) -> bool {
    matches!(v, V::Object(_))
}
fn array(v: &V) -> bool {
    matches!(v, V::Array(_))
}
fn positive(v: &V) -> bool {
    finite(v) && v.n() >= 0.0
}
fn optional(v: &V) -> bool {
    matches!(v, V::Missing)
}
fn string(v: &V) -> bool {
    matches!(v, V::String(_))
}
fn bounded_id(v: &V) -> bool {
    let s = v.text();
    string(v)
        && !s.is_empty()
        && s.len() <= 23
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn point(s: &V, p: &V) -> bool {
    finite(p.get("x"))
        && finite(p.get("y"))
        && p.num("x") >= 25.0
        && p.num("y") >= 25.0
        && p.num("x") <= s.get("world").num("width") - 25.0
        && p.num("y") <= s.get("world").num("height") - 25.0
}
fn unique_ids(rows: &[V]) -> bool {
    let mut keys = HashSet::new();
    rows.iter().all(|x| keys.insert(jsstring(x.get("id"))))
}
pub(super) fn development(s: &V) -> bool {
    let u = s.get("urban");
    let d = u.get("development");
    if optional(d) {
        return true;
    }
    d.truth()
        && d.num("version") == 35.0
        && finite(d.get("started"))
        && d.num("started") >= 420.0
        && d.num("started") <= u.num("lastMinute") + 0.01
        && array(d.get("projects"))
        && d.get("projects").array().len() <= 12
        && unique_ids(d.get("projects").array())
        && d.get("projects").array().iter().all(|p| {
            bounded_id(p.get("id"))
                && string(p.get("name"))
                && p.get("name").text().encode_utf16().count() <= 80
                && ["residential", "business", "industry", "mixed"].contains(&p.get("kind").text())
                && point(s, p)
                && finite(p.get("radius"))
                && p.num("radius") >= 1.0
                && p.num("radius") <= 4.0
                && integer(p.get("startDay"))
                && p.num("startDay") >= 0.0
                && p.num("startDay") <= 24.0
        })
        && (!d.get("last").truth()
            || ["r", "c", "i"].iter().all(|k| {
                positive(d.get("last").get("daily").get(k))
                    && positive(d.get("last").get("added").get(k))
            }))
}
pub(super) fn urban(s: &V, cfg: &V) -> bool {
    if !development(s) {
        return false;
    }
    let u = s.get("urban");
    if !u.truth() {
        return true;
    }
    let types = cfg.get("facilityTypes");
    let facility = |f: &V| {
        types.get(f.get("kind").text()).truth()
            && [1.0, 2.0, 3.0].contains(&f.num("level"))
            && point(s, f)
    };
    if u.get("facilityMode").text() == "automatic"
        && (!array(u.get("autoCandidates"))
            || u.get("autoCandidates").array().len() > 96
            || !u.get("autoCandidates").array().iter().all(facility))
    {
        return false;
    }
    u.num("version") == 19.0
        && ["revision", "step"]
            .iter()
            .all(|k| integer(u.get(k)) && u.num(k) >= 0.0)
        && ["lastMinute", "started"]
            .iter()
            .all(|k| finite(u.get(k)) && u.num(k) >= 420.0)
        && integer(u.get("nextId"))
        && u.num("nextId") > 0.0
        && u.get("cells").truth()
        && u.get("cells").entries().len() <= 24000
        && u.get("cells").entries().iter().all(|(_, c)| {
            c.truth()
                && point(s, c)
                && ["r", "c", "i"]
                    .iter()
                    .all(|k| positive(c.get(k)) && c.num(k) <= 2e5)
        })
        && array(u.get("facilities"))
        && u.get("facilities").array().len() <= 160
        && unique_ids(u.get("facilities").array())
        && u.get("facilities").array().iter().all(facility)
        && array(u.get("history"))
        && u.get("history").array().len() <= 60
}
fn ridership(q: &V) -> bool {
    if !q.truth() {
        return true;
    }
    q.num("version") == 14.0
        && q.get("lines").truth()
        && q.get("lines").entries().len() <= 100
        && q.get("lines").entries().iter().all(|(_, r)| {
            ["awareness", "trust"]
                .iter()
                .all(|k| finite(r.get(k)) && r.num(k) >= 0.0 && r.num(k) <= 1.0)
                && (optional(r.get("satisfaction"))
                    || finite(r.get("satisfaction"))
                        && r.num("satisfaction") >= 0.0
                        && r.num("satisfaction") <= 1.0)
        })
        && q.get("current").truth()
        && q.get("records").truth()
        && ["bestDay", "bestHour", "totalCompleted"]
            .iter()
            .all(|k| positive(q.get("records").get(k)))
        && array(q.get("history"))
        && q.get("history").array().len() <= 30
        && array(q.get("hour"))
        && q.get("hour").array().len() <= 1440
}
fn records(v: &V) -> V {
    V::Object(
        [
            "bestDay",
            "bestHour",
            "totalCompleted",
            "totalPassengerKm",
            "bestNetworkKm",
            "bestLineKm",
            "bestRevenue",
        ]
        .iter()
        .filter(|k| positive(v.get(k)))
        .map(|k| (k.to_string(), v.get(k).clone()))
        .collect(),
    )
}
pub(super) fn signature(s: &V) -> V {
    let rows = s
        .get("services")
        .array()
        .iter()
        .map(|l| {
            arr([
                "id",
                "stops",
                "trackIds",
                "headway",
                "fleet",
                "cars",
                "open",
                "close",
                "fareBands",
                "patterns",
                "loopDirection",
                "stockSpec",
                "fleetManaged",
                "dispatch",
            ]
            .iter()
            .map(|k| l.get(k).clone())
            .collect())
        })
        .collect();
    let tracks = s
        .get("tracks")
        .array()
        .iter()
        .map(|t| {
            arr(["id", "km", "bends", "curve"]
                .iter()
                .map(|k| t.get(k).clone())
                .collect())
        })
        .collect();
    let data = arr(vec![
        s.get("routeModel").clone(),
        arr(rows),
        s.get("depot").clone(),
        if s.get("urban").truth() {
            arr(vec![
                s.get("urban").get("version").clone(),
                s.get("urban").get("revision").clone(),
            ])
        } else {
            V::Null
        },
        arr(tracks),
    ]);
    text(&format!(
        "transit-city-v19|{}|{}",
        jsstring(s.get("region")),
        crate::diagnostics::json(&data)
    ))
}
fn numbers(v: &V, depth: usize, budget: &mut usize) -> u32 {
    *budget += 1;
    if *budget > 2000000 || depth > 80 {
        return 1;
    }
    if matches!(v,V::Number(n) if !n.is_finite()) {
        return 2;
    }
    match v {
        V::Array(a) => {
            for x in a {
                let e = numbers(x, depth + 1, budget);
                if e > 0 {
                    return e;
                }
            }
        }
        V::Object(a) => {
            for (_, x) in a {
                let e = numbers(x, depth + 1, budget);
                if e > 0 {
                    return e;
                }
            }
        }
        _ => {}
    }
    0
}
fn node(s: &V, id: &V) -> bool {
    integer(id)
        && id.n() >= 0.0
        && s.get("nodes")
            .array()
            .get(id.n() as usize)
            .is_some_and(V::truth)
}
fn track(s: &V, t: &V, curve: bool) -> bool {
    string(t.get("id"))
        && node(s, t.get("a"))
        && node(s, t.get("b"))
        && finite(t.get("km"))
        && t.num("km") > 0.0
        && t.get("bends")
            .array()
            .iter()
            .chain(if curve {
                vec![t.get("curve").get("before"), t.get("curve").get("after")]
            } else {
                vec![]
            })
            .filter(|p| p.truth())
            .all(|p| finite(p.get("x")) && finite(p.get("y")))
}
fn token(k: &str) -> Option<Vec<usize>> {
    let a = k.split(':').collect::<Vec<_>>();
    if !(2..=3).contains(&a.len())
        || a.iter()
            .any(|x| x.is_empty() || !x.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    a.into_iter().map(|x| x.parse().ok()).collect()
}
fn field<'a>(v: &'a V, key: &str, index: usize) -> &'a V {
    if array(v) {
        v.array().get(index).unwrap_or(&V::Missing)
    } else {
        v.get(key)
    }
}
fn legs(j: &V) -> &V {
    field(j, "legs", 3)
}
fn journey<'a>(defs: &'a V, k: &str) -> Option<(&'a V, Vec<usize>)> {
    let a = token(k)?;
    Some((defs.array().get(a[0])?, a))
}
fn queue_key(k: &str) -> Option<usize> {
    let a = k.split('|').collect::<Vec<_>>();
    if a.len() != 3 || !matches!(a[1], "1" | "-1") {
        return None;
    }
    let service = a[0].strip_prefix('s')?;
    if service.is_empty()
        || service.split('p').count() > 2
        || service
            .split('p')
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    if a[2].is_empty() || !a[2].bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    a[2].parse().ok()
}
pub(super) fn limits(s: &V, id: usize, cfg: &V) -> (f64, f64) {
    let ls = if s.get("baseLines").truth() {
        s.get("baseLines")
    } else {
        s.get("services")
    };
    let ls = ls
        .array()
        .iter()
        .filter(|l| l.get("stops").array().iter().any(|n| n.n() == id as f64))
        .collect::<Vec<_>>();
    let cars = ls.iter().fold(4.0_f64, |a, l| {
        a.max(if l.get("cars").truth() {
            l.num("cars")
        } else {
            6.0
        })
    });
    let length =
        ls.iter()
            .filter(|l| l.get("fleetManaged").truth())
            .fold(cars * 20.0 + 20.0, |a, l| {
                a.max(
                    cfg.get("specs")
                        .get(l.get("stockSpec").text())
                        .num("length")
                        + 20.0,
                )
            });
    let platforms = (ls.len() as f64 * 2.0).clamp(2.0, 6.0);
    let capacity = (length * 3.0 * platforms / 0.93).floor();
    (capacity, (capacity * 0.5).floor())
}
// Counts can be verified without a forecast, including historical files without saved definitions.
pub(super) fn mass(r: &V) -> bool {
    let mut onboard = 0.0;
    let mut waiting = 0.0;
    let mut ids = HashSet::new();
    for t in r.get("trains").array() {
        if !string(t.get("id"))
            || !ids.insert(t.get("id").text())
            || !object(t.get("passengers"))
            || !positive(t.get("onboard"))
        {
            return false;
        }
        let mut count = 0.0;
        for (k, v) in t.get("passengers").entries() {
            if token(k).is_none() || !positive(v) {
                return false;
            }
            count += v.n();
        }
        if (count - t.num("onboard")).abs() > 1e-5 {
            return false;
        }
        onboard += t.num("onboard");
    }
    for (_, rows) in r
        .get("queues")
        .entries()
        .iter()
        .chain(r.get("outside").entries())
    {
        if !object(rows) {
            return false;
        }
        for (k, v) in rows.entries() {
            if token(k).is_none() || !positive(v) {
                return false;
            }
            waiting += v.n();
        }
    }
    for t in r.get("transfers").array() {
        if !positive(t.get("amount")) {
            return false;
        }
        waiting += t.num("amount");
    }
    (r.num("generated") - r.num("completed") - r.num("cancelled") - waiting - onboard).abs()
        <= 0.1_f64.max(r.num("generated") * 1e-8)
}
// Header checks are also usable before a forecast has been reconstructed.
fn header(s: &V, r: &V) -> bool {
    if !object(r)
        || !finite(r.get("minute"))
        || r.num("minute") < 420.0
        || r.num("minute") > 1e8
        || !array(r.get("trains"))
        || r.get("trains").array().len() > 2400
        || ![
            "queues",
            "waitSince",
            "stationOccupancy",
            "outside",
            "outsideSince",
        ]
        .iter()
        .all(|k| object(r.get(k)))
    {
        return false;
    }
    if r.get("arrivalMode").text() == "integer"
        && (!positive(r.get("arrivalRemainder"))
            || r.num("arrivalRemainder") >= 1.0 + 1e-8
            || !positive(r.get("expectedGenerated"))
            || !integer(r.get("rngState"))
            || r.num("rngState") < 0.0
            || r.num("rngState") > 4294967295.0)
    {
        return false;
    }
    if ![
        "generated",
        "completed",
        "cancelled",
        "boarded",
        "alighted",
        "revenue",
        "vehicleExpense",
        "nextId",
    ]
    .iter()
    .all(|k| positive(r.get(k)))
    {
        return false;
    }
    if !optional(r.get("transfers")) && !array(r.get("transfers")) {
        return false;
    }
    let retired = r.get("retiredTracks");
    if retired.truth()
        && (!array(retired)
            || retired.array().len() > 5000
            || !retired.array().iter().all(|t| track(s, t, false)))
    {
        return false;
    }
    let archives = r.get("routeArchives");
    if archives.truth()
        && (!object(archives)
            || archives.entries().len() > 2400
            || !archives.entries().iter().all(|(_, a)| {
                array(a.get("tracks"))
                    && a.get("tracks").array().len() <= 120
                    && a.get("tracks").array().iter().all(|t| track(s, t, true))
            }))
    {
        return false;
    }
    mass(r)
}
fn restore(s: &V, plan: &V, r: &V, defs: &V, cfg: &V) -> bool {
    if !header(s, r) {
        return false;
    }
    let services = plan.get("services").array();
    let archives = r.get("routeArchives");
    let saved_defs = r.get("urbanDefs");
    let native_defs =
        s.get("urban").truth() && (saved_defs.truth() || r.get("hasUrbanDefs").truth());
    let defs = if saved_defs.truth() && s.get("urban").truth() {
        saved_defs
    } else {
        defs
    };
    if native_defs
        && (!array(defs)
            || defs.array().len() > 300000
            || !defs.array().iter().enumerate().all(|(i, j)| {
                field(j, "id", 0).n() == i as f64
                    && positive(field(j, "daily", 1))
                    && positive(field(j, "fare", 2))
                    && array(legs(j))
                    && !legs(j).array().is_empty()
                    && legs(j).array().iter().all(|e| {
                        [1.0, -1.0].contains(&field(e, "dir", 1).n())
                            && node(s, field(e, "from", 2))
                            && node(s, field(e, "to", 3))
                            && (field(j, "daily", 1).n() <= 0.0
                                || services.iter().any(|l| {
                                    eq(l.get("id"), field(e, "service", 0))
                                        && l.get("stops")
                                            .array()
                                            .iter()
                                            .any(|n| eq(n, field(e, "from", 2)))
                                        && l.get("stops")
                                            .array()
                                            .iter()
                                            .any(|n| eq(n, field(e, "to", 3)))
                                }))
                    })
            }))
    {
        return false;
    }
    let mut onboard = 0.0;
    for t in r.get("trains").array() {
        let l = if t.get("retiringRun").truth() {
            t.get("retiringRun")
        } else {
            services
                .iter()
                .find(|l| eq(l.get("id"), t.get("service")))
                .unwrap_or(&V::Missing)
        };
        let archived = archives.get(t.get("retiringKey").text());
        if t.get("retiringKey").truth() && !archived.truth() {
            return false;
        }
        if t.get("retiringRun").truth() {
            if !array(l.get("stops"))
                || !array(l.get("trackIds"))
                || l.get("stops").array().len() != l.get("trackIds").array().len() + 1
                || l.get("stops").array().len() > 120
                || !l.get("stops").array().iter().all(|id| node(s, id))
            {
                return false;
            }
            let tracks = if archived.get("tracks").truth() {
                archived.get("tracks")
            } else {
                plan.get("tracks")
            };
            for (i, id) in l.get("trackIds").array().iter().enumerate() {
                let a = &l.get("stops").array()[i];
                let b = &l.get("stops").array()[i + 1];
                if !tracks.array().iter().any(|tr| {
                    eq(tr.get("id"), id)
                        && ((eq(tr.get("a"), a) && eq(tr.get("b"), b))
                            || (eq(tr.get("b"), a) && eq(tr.get("a"), b)))
                }) {
                    return false;
                }
            }
        }
        let cap = if l.get("fleetManaged").truth() {
            cfg.get("specs")
                .get(l.get("stockSpec").text())
                .num("capacity")
        } else {
            (if l.get("cars").truth() {
                l.num("cars")
            } else {
                8.0
            }) * 100.0
        };
        let joined = |v: &V| v.array().iter().map(jsstring).collect::<Vec<_>>().join(",");
        if !l.truth()
            || !array(t.get("stops"))
            || !array(t.get("trackIds"))
            || joined(t.get("stops")) != joined(l.get("stops"))
            || joined(t.get("trackIds")) != joined(l.get("trackIds"))
            || !finite(t.get("capacity"))
            || t.num("capacity") != cap
            || !positive(t.get("onboard"))
            || t.num("onboard") > cap + 1e-5
            || !["moving", "dwell", "signal"].contains(&t.get("status").text())
            || !integer(t.get("index"))
            || !node(s, at(t.get("stops"), t.get("index")))
        {
            return false;
        }
        for (k, _) in t.get("passengers").entries() {
            if !journey(defs, k).is_some_and(|(j, t)| t[1] < legs(j).array().len()) {
                return false;
            }
        }
        onboard += t.num("onboard");
    }
    let mut counted = std::collections::BTreeMap::<usize, f64>::new();
    let mut waiting = 0.0;
    for (k, q) in r.get("queues").entries() {
        let Some(id) = queue_key(k) else {
            return false;
        };
        if !object(q) {
            return false;
        }
        for (k, n) in q.entries() {
            if !journey(defs, k).is_some_and(|(j, t)| t[1] < legs(j).array().len()) || !positive(n)
            {
                return false;
            }
            *counted.entry(id).or_default() += n.n();
            waiting += n.n();
        }
    }
    for x in r.get("transfers").array() {
        let j = at(defs, x.get("journey"));
        if !at(legs(j), x.get("leg")).truth()
            || !positive(x.get("amount"))
            || !finite(x.get("ready"))
            || !node(s, x.get("station"))
        {
            return false;
        }
        *counted.entry(x.num("station") as usize).or_default() += x.num("amount");
        waiting += x.num("amount");
    }
    for (id, q) in r.get("outside").entries() {
        let Ok(id_num) = id.parse::<usize>() else {
            return false;
        };
        if !node(s, &n(id_num as f64)) || !object(q) {
            return false;
        }
        let mut count = 0.0;
        for (k, value) in q.entries() {
            let Some((j, t)) = journey(defs, k) else {
                return false;
            };
            if !eq(
                field(at(legs(j), &n(t[1] as f64)), "from", 2),
                &n(id_num as f64),
            ) || !positive(value)
                || !finite(r.get("outsideSince").get(&format!("{id}#{k}")))
            {
                return false;
            }
            count += value.n();
        }
        waiting += count;
        if s.num("routeModel") == 9.0 {
            let limit = limits(s, id_num, cfg).1.max(min(
                10000.0,
                r.get("stationLimits").get(id).zero("outsideCapacity"),
            ));
            if count > limit + 1e-5 {
                return false;
            }
        }
    }
    let mut ids = counted.keys().copied().collect::<HashSet<_>>();
    for (id, _) in r.get("stationOccupancy").entries() {
        let Ok(id) = id.parse() else {
            return false;
        };
        ids.insert(id);
    }
    for id in ids {
        let count = *counted.get(&id).unwrap_or(&0.0);
        let actual = r.get("stationOccupancy").get(&id.to_string());
        let actual = if actual.truth() { actual.n() } else { 0.0 };
        if !actual.is_finite() || (count - actual).abs() > 1e-5 {
            return false;
        }
        if s.num("routeModel") == 9.0 {
            let limit = limits(s, id, cfg).0.max(min(
                20000.0,
                r.get("stationLimits").get(&id.to_string()).zero("capacity"),
            ));
            if count > limit + 1e-5 {
                return false;
            }
        }
    }
    (r.num("generated") - r.num("completed") - r.num("cancelled") - waiting - onboard).abs()
        <= 0.1_f64.max(r.num("generated") * 1e-8)
}
fn accept(v: &V, cfg: &V, structure: &V) -> u32 {
    if !object(v) {
        return 3;
    }
    if has(v, "format")
        && (v.get("format").text() != "rail-local-save" || !eq(v.get("formatVersion"), &n(1.0)))
    {
        return 4;
    }
    if has(v, "runtimeVersion") && !eq(v.get("runtimeVersion"), &n(1.0)) {
        return 4;
    }
    if v.num("gameVersion") != 7.0 {
        return 5;
    }
    let s = v.get("state");
    if !s.truth()
        || !["tokyo", "gba"].contains(&s.get("region").text())
        || v.get("region").truth() && !eq(v.get("region"), s.get("region"))
    {
        return 6;
    }
    let e = if structure.truth() {
        if structure.num("values") > 2000000.0 || structure.num("depth") > 80.0 {
            1
        } else if structure.get("nonfinite").truth() {
            2
        } else {
            0
        }
    } else {
        numbers(v, 0, &mut 0)
    };
    if e > 0 {
        return e;
    }
    if !E::validate(s, cfg)
        || !crate::assets::economy_valid(s)
        || !unique_ids(s.get("economy").get("loans").array())
        || !urban(s, cfg)
        || !crate::diagnostic_review::valid(s)
        || !ridership(s.get("ridership"))
    {
        return 7;
    }
    if v.get("runtime").truth() {
        if !eq(v.get("signature"), &signature(s)) {
            return 8;
        }
        if !header(s, v.get("runtime")) {
            return 9;
        } // Urban snapshots carry canonical definitions, so full association checks can run before restore.
        if s.get("urban").truth() && v.get("runtime").get("urbanDefs").truth() {
            let Ok(mut p) = expanded(s, s.get("economy").num("minute")) else {
                return 9;
            };
            p.set(
                "tracks",
                arr(s
                    .get("tracks")
                    .array()
                    .iter()
                    .chain(v.get("runtime").get("retiredTracks").array())
                    .cloned()
                    .collect()),
            );
            if !restore(s, &p, v.get("runtime"), &V::Missing, cfg) {
                return 9;
            }
        }
    }
    0
}
fn definitions(plan: &V, flows: &V, offset: f64) -> V {
    arr(flows
        .array()
        .iter()
        .enumerate()
        .map(|(id, f)| {
            let path = f.get("path");
            let mut legs = vec![];
            let mut from = f.get("from").clone();
            for e in path.get("edges").array() {
                let l = plan
                    .get("services")
                    .array()
                    .iter()
                    .find(|l| eq(l.get("id"), e.get("service")))
                    .expect("definition service");
                let i = l
                    .get("trackIds")
                    .array()
                    .iter()
                    .enumerate()
                    .find(|(i, t)| {
                        let a = at(l.get("stops"), &n(*i as f64));
                        let b = at(l.get("stops"), &n(*i as f64 + 1.0));
                        eq(t, e.get("track"))
                            && ((eq(a, &from) && eq(b, e.get("to")))
                                || (eq(b, &from) && eq(a, e.get("to"))))
                    })
                    .map(|(i, _)| i);
                let dir = if e.get("dir").truth() {
                    e.get("dir").clone()
                } else {
                    n(
                        if i.is_some_and(|i| eq(at(l.get("stops"), &n(i as f64)), &from)) {
                            1.0
                        } else {
                            -1.0
                        },
                    )
                };
                let extend = legs.last().is_some_and(|c: &V| {
                    eq(c.get("service"), l.get("id")) && eq(c.get("dir"), &dir)
                });
                if extend {
                    legs.last_mut().unwrap().set("to", e.get("to").clone());
                } else {
                    legs.push(obj(&[
                        ("service", l.get("id").clone()),
                        ("dir", dir),
                        ("from", from.clone()),
                        ("to", e.get("to").clone()),
                    ]));
                }
                from = e.get("to").clone();
            }
            let mut by = obj(&[]);
            if path.get("fares").truth() && path.num("fare") > 0.0 {
                for (k, v) in path.get("fares").entries() {
                    by.set(k, n(v.n() / path.num("fare")));
                }
            } else {
                for e in path.get("edges").array() {
                    let k = e.get("service").text();
                    by.set(k, n(by.zero(k) + e.num("km") / path.num("km")));
                }
            }
            let ids = if path.get("fares").truth() {
                path.get("fares")
            } else {
                &by
            };
            obj(&[
                ("id", n(id as f64 + offset)),
                ("legs", arr(legs)),
                (
                    "daily",
                    if optional(f.get("demandTrips")) || matches!(f.get("demandTrips"), V::Null) {
                        f.get("trips").clone()
                    } else {
                        f.get("demandTrips").clone()
                    },
                ),
                ("fare", path.get("fare").clone()),
                (
                    "purpose",
                    if f.get("purpose").truth() {
                        f.get("purpose").clone()
                    } else {
                        text("work")
                    },
                ),
                ("back", boolean(f.get("back").truth())),
                (
                    "hub",
                    if f.get("hub").truth() {
                        f.get("hub").clone()
                    } else {
                        V::Null
                    },
                ),
                (
                    "externalKind",
                    if f.get("externalKind").truth() {
                        f.get("externalKind").clone()
                    } else {
                        V::Null
                    },
                ),
                ("from", f.get("from").clone()),
                ("to", f.get("to").clone()),
                (
                    "lineIds",
                    arr(ids.entries().iter().map(|(k, _)| text(k)).collect()),
                ),
                ("byLine", by),
            ])
        })
        .collect())
}
fn legacy_windows(v: &V) -> V {
    let minute = v.num("minute");
    let day = ((minute % 1440.0) + 1440.0) % 1440.0;
    let base = minute - day;
    let mut until = base + 1440.0;
    let mut ids = vec![];
    for l in v.get("services").array() {
        let opening = if optional(l.get("open")) || matches!(l.get("open"), V::Null) {
            0.0
        } else {
            l.num("open")
        };
        let closing = if optional(l.get("close")) || matches!(l.get("close"), V::Null) {
            1440.0
        } else {
            l.num("close")
        };
        if day >= opening
            && day < closing
            && (!l.get("fleetManaged").truth() || l.num("fleet") > 0.0)
        {
            ids.push(l.get("id").clone());
        }
        for point in [opening, closing] {
            let time = base + point;
            if time > minute && time < until {
                until = time;
            }
        }
    }
    obj(&[("start", n(minute)), ("until", n(until)), ("ids", arr(ids))])
}
fn legacy_dispatch(v: &V, cfg: &V) -> V {
    let s = v.get("state");
    let minute = v.num("minute");
    let mut next = v.num("nextId");
    let mut trains = vec![];
    let mut updates = vec![];
    for (i, row) in v.get("records").array().iter().enumerate() {
        let action = row.num("action");
        if action < 0.0 {
            continue;
        }
        let spawn = action == 1.0;
        if spawn {
            let l = row.get("l");
            let dir = row.num("dir");
            let st = l.get("stops");
            let ring = eq(first(st.array()), last(st.array()));
            let dwell = if ring {
                loop_dwell(s, l).expect("legacy loop dwell")
            } else {
                0.6
            };
            let cap = if l.get("fleetManaged").truth() {
                cfg.get("specs")
                    .get(l.get("stockSpec").text())
                    .num("capacity")
            } else {
                (if l.get("cars").truth() {
                    l.num("cars")
                } else {
                    8.0
                }) * 100.0
            };
            let serial = jsstring(&n(next));
            next += 1.0;
            trains.push(obj(&[
                ("id", text(&format!("T{:0>4}", serial))),
                ("service", l.get("id").clone()),
                (
                    "parentLine",
                    if l.get("parentLine").truth() {
                        l.get("parentLine").clone()
                    } else {
                        l.get("id").clone()
                    },
                ),
                (
                    "callStops",
                    if l.get("callStops").truth() {
                        l.get("callStops").clone()
                    } else {
                        st.clone()
                    },
                ),
                ("dir", n(dir)),
                ("stops", st.clone()),
                ("trackIds", l.get("trackIds").clone()),
                (
                    "index",
                    n(if dir == 1.0 {
                        0.0
                    } else {
                        st.array().len() as f64 - 1.0
                    }),
                ),
                ("status", text("dwell")),
                ("ready", n(minute + dwell)),
                ("onboard", n(0.0)),
                ("capacity", n(cap)),
                ("passengers", obj(&[])),
                ("progress", n(0.0)),
                ("loop", boolean(ring)),
                ("segment", V::Null),
            ]));
        }
        updates.push(arr(vec![
            n(i as f64),
            row.get("next").clone(),
            boolean(spawn),
        ]));
    }
    obj(&[
        ("trains", arr(trains)),
        ("updates", arr(updates)),
        ("nextId", n(next)),
    ])
}
fn checkpoint(v: &V, region: &V, cfg: &V) -> V {
    let kind = if eq(v.get("gameVersion"), &n(7.0)) {
        7.0
    } else if eq(v.get("gameVersion"), &n(6.0)) {
        6.0
    } else {
        0.0
    };
    let s = if kind > 0.0 { v.get("state") } else { v };
    let version = kind != 7.0 || !has(v, "runtimeVersion") || eq(v.get("runtimeVersion"), &n(1.0));
    let valid = version && E::validate(s, cfg) && eq(s.get("region"), region);
    let use_runtime =
        valid && kind == 7.0 && v.get("runtime").truth() && eq(v.get("signature"), &signature(s));
    let runtime_ok = !use_runtime || header(s, v.get("runtime"));
    obj(&[
        ("valid", boolean(valid && runtime_ok)),
        ("kind", n(kind)),
        ("useRuntime", boolean(use_runtime && runtime_ok)),
        ("records", records(v.get("personalRecords"))),
    ])
}
pub(super) fn run(v: &V, cfg: &V) -> V {
    let s = v.get("state");
    match v.get("op").text() {
        "checkpoint" => checkpoint(v.get("value"), v.get("region"), cfg),
        "legacyWindows" => legacy_windows(v),
        "legacyDispatch" => legacy_dispatch(v, cfg),
        "definitions" => definitions(v.get("plan"), v.get("flows"), v.zero("offset")),
        "catalogValid" => boolean(
            array(v.get("value"))
                && v.get("value").array().iter().all(|j| {
                    positive(at(j, &n(0.0))) && positive(at(j, &n(1.0))) && at(j, &n(2.0)).n() > 0.0
                }),
        ),
        "signature" => signature(s),
        "urban" => boolean(urban(s, cfg)),
        "development" => {
            let d = s.get("urban").get("development");
            if !optional(d) && !d.truth() {
                d.clone()
            } else {
                boolean(development(s))
            }
        }
        "ridership" => boolean(ridership(v.get("value"))),
        "records" => records(v.get("value")),
        "restore" => boolean(restore(
            s,
            v.get("plan"),
            v.get("saved"),
            v.get("defs"),
            cfg,
        )),
        "accept" => n(accept(v.get("value"), cfg, v.get("structure")) as f64),
        _ => panic!("unknown save transaction"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_walk_counts_values_and_rejects_nonfinite() {
        let v = arr(vec![n(1.0), n(f64::INFINITY)]);
        assert_eq!(numbers(&v, 0, &mut 0), 2);
        assert_eq!(numbers(&V::Null, 81, &mut 0), 1);
        assert_eq!(numbers(&V::Null, 0, &mut 2000000), 1);
    }
    #[test]
    fn tokens_require_complete_unsigned_indices() {
        for s in ["0", "1:-1", "a:0", "1:2:", "1:2:3:4"] {
            assert!(token(s).is_none());
        }
        assert_eq!(token("10:2:420"), Some(vec![10, 2, 420]));
        assert_eq!(queue_key("s17p2|-1|0"), Some(0));
        assert!(queue_key("s17p|-1|0").is_none());
    }
    #[test]
    fn future_runtime_schema_is_rejected_before_model_acceptance() {
        let v = obj(&[("runtimeVersion", n(2.0))]);
        assert_eq!(accept(&v, &V::Missing, &V::Missing), 4);
    }
    #[test]
    fn negative_and_unbalanced_train_weights_fail() {
        let train = obj(&[
            ("id", text("T0001")),
            ("onboard", n(2.0)),
            ("passengers", obj(&[("0:0", n(1.0))])),
        ]);
        let r = obj(&[
            ("trains", arr(vec![train])),
            ("generated", n(2.0)),
            ("completed", n(0.0)),
            ("cancelled", n(0.0)),
        ]);
        assert!(!mass(&r));
    }
}
