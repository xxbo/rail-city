//! Build the two parts of the world ABI surrounding the raw city cell table.
//! An optional resident graph supplies edges in exactly the routing kernel's order.
use crate::{bootstrap, editor_support::*, value::Value as V};
use std::collections::{HashMap, HashSet};

#[derive(Hash, Eq, PartialEq)]
enum TrackId<'a> { Name(&'a str), Number(u64) }
fn track_id(v: &V) -> Result<TrackId<'_>, &'static str> {
    match v {
        V::String(id) => Ok(TrackId::Name(id)),
        V::Number(id) if id.is_finite() => Ok(TrackId::Number(if *id == 0.0 { 0 } else { id.to_bits() })),
        _ => Err("INVALID_FORECAST_TRACK"),
    }
}

pub(super) fn frame(input: &V, graph: Option<&V>) -> Result<V, String> {
    let world = input.get("state");
    let city = input.get("city");
    if !integer(city.get("count")) || !(0.0..=u32::MAX as f64).contains(&city.num("count")) {
        return Err("INVALID_FORECAST_CELL_COUNT".into());
    }
    let nodes = world.get("nodes").array();
    let tracks = world.get("tracks").array();
    let plan = expanded(world, minute(world))?;
    let services = plan.get("services").array();
    let effective = city.get("effectiveConnections").truth();
    let mut stops = vec![];
    let mut seen = vec![false; nodes.len()];
    for line in services {
        if effective && !(line.num("fleet") > 0.0) { continue; }
        let calls = if line.get("callStops").truth() { line.get("callStops") } else { line.get("stops") };
        for id in calls.array() {
            if !integer(id) || id.n() < 0.0 || id.n() >= nodes.len() as f64 { return Err("INVALID_FORECAST_STOP".into()); }
            if !std::mem::replace(&mut seen[id.n() as usize], true) { stops.push(id.n()); }
        }
    }

    let mut tail = vec![];
    let mut hub_views = vec![];
    let hubs = bootstrap::hubs(bootstrap::region_id(world.get("region").text()));
    for hub in hubs.array() {
        let env = bootstrap::envelope(hub);
        let access = bootstrap::access(hub);
        let reference = access.num("railReference");
        tail.extend([hub.num("x"), hub.num("y")]);
        for k in ["movements","landside","visitorArrivals","visitorReturns","localDepartures","localReturns"] {
            tail.push(env.num(k));
        }
        tail.extend([access.zero("staff"), reference]);
        hub_views.push(obj(&[("id", hub.get("id").clone()), ("referenceTarget", n(env.num("landside") * reference)),
            ("railReference", n(reference)), ("envelope", env)]));
    }

    let edges = graph.map_or(&[][..], |g| g.get("edges").array());
    if graph.is_some() {
        let mut indices = HashMap::new();
        for (i, t) in tracks.iter().enumerate() { indices.insert(track_id(t.get("id"))?, i); }
        let index = |id: &V| indices.get(&track_id(id)?).copied().ok_or("INVALID_FORECAST_TRACK");
        for line in services {
            let mut seen = HashSet::new();
            let mut row = vec![];
            for id in line.get("trackIds").array() {
                let ix = index(id)?;
                if seen.insert(ix) { row.push(ix as f64); }
            }
            tail.extend([service_headway(&plan, line)?, crate::legacy::capacity(line), row.len() as f64]);
            tail.extend(row);
        }
        for edge in edges {
            let ids = if edge.get("tracks").truth() { edge.get("tracks").array() }
                      else { std::slice::from_ref(edge.get("track")) };
            tail.push(ids.len() as f64);
            for id in ids { tail.push(index(id)? as f64); }
        }
    }
    let urban = world.get("urban");
    let cfg = bootstrap::config();
    let balance = cfg.get("balance");
    let mut head = vec![1.0, input.num("token"), effective as u8 as f64, urban.truth() as u8 as f64,
        urban.zero("version"), urban.zero("step"), fallback(city.get("demandZoneUnits"), 80.0),
        balance.num("HUB_CAPTURE_MAX"), balance.num("HUB_MARKET_SCALE")];
    for k in ["people","jobs","shops","industry","leisure"] { head.push(city.get("totals").num(k)); }
    head.extend([nodes.len() as f64, stops.len() as f64, city.num("count"), hubs.array().len() as f64,
        if graph.is_some() { services.len() as f64 } else { 0.0 }, tracks.len() as f64,
        edges.len() as f64, world.get("services").array().len() as f64]);
    for node in nodes { head.extend([node.num("x"), node.num("y")]); }
    head.extend(stops);
    Ok(obj(&[("head", arr(head.into_iter().map(n).collect())), ("tail", arr(tail.into_iter().map(n).collect())),
        ("effective", boolean(effective)), ("hubs", arr(hub_views))]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_codec::parse;

    #[test]
    fn station_order_and_track_indices_match_the_resident_graph() {
        let mut input = parse(r#"{"token":17,"city":{"count":1,"effectiveConnections":true,"totals":{}},
            "state":{"region":"gba","routeModel":9,"operatingPlan":true,"nodes":[{"x":2,"y":5},{"x":4,"y":6},{"x":8,"y":9}],
            "tracks":[{"id":"1","km":2},{"id":1,"km":3}],
            "services":[{"stops":[2,1,0,2],"callStops":[2,0,2],"trackIds":[1,"1",1],"fleet":2,"headway":6},
            {"stops":[1,0],"trackIds":["1"],"fleet":0,"headway":6}]}}"#).unwrap();
        let graph = parse(r#"{"edges":[{"track":"1"},{"tracks":[1,"1",1]}]}"#).unwrap();
        let result = frame(&input, Some(&graph)).unwrap();
        let head = result.get("head").array().iter().map(V::n).collect::<Vec<_>>();
        assert_eq!(&head[0..3], &[1.0,17.0,1.0]);
        assert_eq!(head[6],80.0);
        assert_eq!(&head[14..17], &[3.0,2.0,1.0]);
        assert_eq!(&head[18..22], &[2.0,2.0,2.0,2.0]);
        assert_eq!(&head[28..], &[2.0,0.0]);
        let hubs = result.get("hubs").array().len();
        assert_eq!(hubs, bootstrap::hubs("gba").array().len());
        let tail = result.get("tail").array().iter().map(V::n).collect::<Vec<_>>();
        let runs = &tail[10*hubs..];
        assert_eq!(&runs[1..5], &[800.0,2.0,1.0,0.0]);
        assert_eq!(&runs[9..], &[1.0,0.0,3.0,1.0,0.0,1.0]);

        input.get_mut("city").set("effectiveConnections",boolean(false));
        let spatial = frame(&input, None).unwrap();
        let head = spatial.get("head").array();
        assert_eq!(head[18].n(),0.0);
        assert_eq!(head[20].n(),0.0);
        assert_eq!(head[28..].iter().map(V::n).collect::<Vec<_>>(),vec![2.0,0.0,1.0]);
        assert_eq!(spatial.get("tail").array().len(),10*hubs);
        let bad = parse(r#"{"edges":[{"track":"absent"}]}"#).unwrap();
        assert!(frame(&input,Some(&bad)).is_err());
    }
}
