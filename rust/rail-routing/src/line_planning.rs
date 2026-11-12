//! Read-only plans for the line editor. Applying a draft still uses network.configure.
use crate::{editor_support::*, services, value::Value as V};

pub(super) fn recommendation(world: &V, line: &V, riders: f64, stations: &V, cfg: &V) -> V {
    let potential = unique(line.get("stops").array()).iter().map(|id| {
        let station = stations.get(&jsstring(id));
        (station.zero("people") + 0.7 * station.zero("jobs")) * 0.15
    }).sum::<f64>();
    crate::assets::recommend(world, line, riders.max(potential), cfg)
}

// Prefer the existing two termini. Adjacent stops provide usable endpoints on a
// loop or when the longer path would repeat a station on the connecting line.
fn endpoints(stops: &[f64], join: usize, reverse: bool) -> Vec<usize> {
    let last = stops.len() - 1;
    let mut choices = if reverse { vec![last, 0] } else { vec![0, last] };
    if stops[0] == stops[last] && last > 1 { choices.push(last - 1); }
    if join > 0 { choices.push(join - 1); }
    if join < last { choices.push(join + 1); }
    let mut out = Vec::new();
    for index in choices {
        if stops[index] != stops[join] && !out.contains(&index) { out.push(index); }
    }
    out
}

fn connection(lines: &[services::Line], source: usize, target: usize) -> Option<(usize,usize,usize)> {
    let (line, other) = (&lines[source], &lines[target]);
    if source == target || (line.managed && other.managed && line.spec != other.spec) { return None; }
    for (to, station) in line.stops.iter().enumerate() {
        let Some(join) = other.stops.iter().position(|id| id == station) else { continue };
        for from in endpoints(&line.stops, to, false) {
            for end in endpoints(&other.stops, join, true) {
                let p = services::Pattern { kind: 4, from: from as f64, to: to as f64, fleet: 2.0,
                    calls: vec![], target: target as i32, end: end as f64, default: false };
                if services::compile(lines, source, &p, 0.0, 480.0).is_ok() {
                    return Some((from, to, end));
                }
            }
        }
    }
    None
}

fn targets(world: &V, source: usize) -> impl Iterator<Item = V> + '_ {
    let frame = service_frame(world, 480.0, false).0;
    let (_, _, _, _, lines, _) = services::decode(&frame);
    world.get("services").array().iter().enumerate().filter_map(move |(i, other)| {
        let (from, to, end) = connection(&lines, source, i)?;
        Some(obj(&[("target", other.get("id").clone()), ("from", n(from as f64)),
            ("to", n(to as f64)), ("targetEnd", n(end as f64))]))
    })
}

pub(super) fn donate_pair(rows: &mut [V]) -> bool {
    let Some(donor) = rows.iter_mut().find(|p| p.num("fleet") >= 4.0) else { return false };
    donor.set("fleet", n(donor.num("fleet") - 2.0));
    true
}

fn add(world: &V, source: usize, rows: &[V], kind: &str) -> Result<V, &'static str> {
    if rows.len() >= 8 { return Err("每条线路最多 8 个交路。"); }
    let line = &world.get("services").array()[source];
    let stops = line.get("stops").array();
    if !KINDS.contains(&kind) || stops.len() < 2 { return Err("交路类型或端点无效。"); }
    let mut to = stops.len() - 1;
    match kind {
        "short" if stops.len() < 3 => return Err("小交路至少需要 3 座车站。"),
        "short" => to -= 1,
        "direct" if eq(&stops[0], &stops[to]) => {
            to = stops.iter().rposition(|id| !eq(id, &stops[0])).ok_or("直达交路的起终点必须不同。")?;
        }
        _ => {}
    }
    let mut p = obj(&[("kind", text(kind)), ("from", n(0.0)), ("to", n(to as f64)),
        ("fleet", n(2.0)), ("headway", line.get("headway").clone()), ("calls", arr(stops.to_vec()))]);
    if kind == "cross" {
        let target = targets(world, source).next().ok_or("没有可接续的跨线交路，请检查共站、车型与编组。")?;
        for (key, value) in target.entries() { p.set(key, value.clone()); }
    }

    let mut draft = rows.to_vec();
    let total = draft.iter().map(|p| p.num("fleet")).sum::<f64>();
    if !draft.iter().all(|p| integer(p.get("fleet")) && p.num("fleet") >= 2.0 && p.num("fleet") % 2.0 == 0.0)
        || total > line.num("fleet") { return Err("请先检查已有交路的车辆配额。"); }
    if total + 2.0 > line.num("fleet") && !donate_pair(&mut draft) {
        return Err("配属车辆不足，请先购买并增加线路投放数量。");
    }
    draft.push(p);
    Ok(arr(draft))
}

pub(super) fn query(world: &V, args: &V) -> Result<V, &'static str> {
    let source = world.get("services").array().iter().position(|l| eq(l.get("id"), args.get("lineId")))
        .ok_or("线路不存在。")?;
    let rows = args.get("patterns").array();
    match args.get("operation").text() {
        "targets" => Ok(arr(targets(world, source).collect())),
        "add" => add(world, source, rows, args.get("patternKind").text()),
        "remove" => {
            if rows.len() <= 1 { return Err("至少保留一个交路。"); }
            let index = args.get("index");
            if !integer(index) || index.n() < 0.0 || index.n() >= rows.len() as f64 { return Err("交路不存在。"); }
            let mut draft = rows.to_vec();
            draft.remove(index.n() as usize);
            Ok(arr(draft))
        }
        _ => Err("未知的交路草案操作。"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_codec::parse;

    #[test]
    fn fleet_and_cross_line_drafts_leave_the_input_intact() {
        let world = parse(r#"{"services":[
          {"id":"A","stops":[1,2,3,1],"trackIds":[0,1,2],"fleet":6,"headway":8,"stockSpec":"6A","fleetManaged":true,"dispatch":{"manual":6}},
          {"id":"B","stops":[1,4],"trackIds":[3],"stockSpec":"6B","fleetManaged":true},
          {"id":"C","stops":[1,5,6,1],"trackIds":[4,5,6],"stockSpec":"6A","fleetManaged":true}
        ]}"#).unwrap();
        let existing = parse(r#"[{"kind":"local","from":0,"to":3,"fleet":6}]"#).unwrap();
        let cross = add(&world, 0, existing.array(), "cross").unwrap();
        assert_eq!(cross.array()[0].num("fleet"), 4.0);
        assert_eq!(existing.array()[0].num("fleet"), 6.0);
        let new = &cross.array()[1];
        assert_eq!(new.get("target").text(), "C");
        assert_eq!((new.num("from"), new.num("to"), new.num("targetEnd")), (2.0, 0.0, 2.0));
        assert_eq!(add(&world, 0, existing.array(), "direct").unwrap().array()[1].num("to"), 2.0);
        let spare = parse(r#"[{"kind":"local","fleet":2}]"#).unwrap();
        assert_eq!(add(&world, 0, spare.array(), "short").unwrap().array()[0].num("fleet"), 2.0);
        let drop = obj(&[("lineId",text("A")), ("operation",text("remove")), ("index",n(1.0)), ("patterns",cross.clone())]);
        assert_eq!(query(&world,&drop).unwrap().array().len(), 1);
        assert_eq!(cross.array().len(), 2);
        let mut last = drop.clone();
        last.set("patterns",spare);
        assert!(query(&world,&last).is_err());
        let full = parse(r#"[{"fleet":2},{"fleet":2},{"fleet":2}]"#).unwrap();
        assert!(add(&world, 0, full.array(), "short").is_err());
    }

    #[test]
    fn dispatch_uses_distinct_stations_and_the_higher_demand_estimate() {
        let world = parse(r#"{"tracks":[{"id":0,"km":16}],"services":[],"depot":{"stock":{"6A":80}}}"#).unwrap();
        let line = parse(r#"{"id":"A","stockSpec":"6A","stops":[0,1,2,0],"trackIds":[0],"fleet":12}"#).unwrap();
        let cfg = parse(r#"{"specs":{"6A":{"capacity":200}}}"#).unwrap();
        let stations = parse(r#"{"0":{"people":60000,"jobs":20000},"1":{"people":6000}}"#).unwrap();
        for (observed, expected) in [(0.0, 12000.0), (20000.0, 20000.0)] {
            let result = recommendation(&world,&line,observed,&stations,&cfg);
            let plan = crate::assets::recommend(&world,&line,expected,&cfg);
            for field in ["offPeak","peak","peakNeed"] { assert_eq!(result.num(field), plan.num(field)); }
        }
    }
}
