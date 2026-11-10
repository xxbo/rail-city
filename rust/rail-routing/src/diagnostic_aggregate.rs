//! Numeric forecast scan. Resolve identifiers once per revision, not once per trip/edge.
use crate::{
    diagnostics::{factor, km, physical, track_key, Flow},
    editor_support::*,
    value::Value as V,
};
use std::collections::HashMap;
pub(super) struct Aggregation {
    pub totals: V,
    pub details: V,
    pub journeys: f64,
    pub passenger_km: f64,
    pub transfer_trips: f64,
}
struct Edge {
    service: usize,
    line: Option<usize>,
    parts: Vec<usize>,
    tracks: Vec<usize>,
    to: usize,
    km: f64,
}
struct Line {
    riders: f64,
    revenue: f64,
    stops: Vec<V>,
    stations: HashMap<usize, usize>,
    board: Vec<f64>,
    alight: Vec<f64>,
    demand: Vec<f64>,
    present: Vec<bool>,
    order: Vec<usize>,
    center_riders: f64,
    long: f64,
}
pub(super) fn aggregate(
    s: &V,
    op: &V,
    meta: &V,
    profiles: &[Flow],
    center: bool,
    metrics: bool,
) -> Aggregation {
    let lines = s.get("services").array();
    let line_ids = lines
        .iter()
        .enumerate()
        .map(|(i, l)| (l.get("id").text(), i))
        .collect::<HashMap<_, _>>();
    let graph = meta.get("graph");
    let fare_lines = graph.get("lines").array();
    let normal = fare_lines
        .iter()
        .map(|id| factor(s, std::slice::from_ref(id), false))
        .collect::<Vec<_>>();
    let hub = fare_lines
        .iter()
        .map(|id| factor(s, std::slice::from_ref(id), true))
        .collect::<Vec<_>>();
    let map_fares = fare_lines
        .iter()
        .map(|id| line_ids.get(id.text()).copied())
        .collect::<Vec<_>>();
    let runs = op
        .get("services")
        .array()
        .iter()
        .map(|r| (r.get("id").text(), r))
        .collect::<HashMap<_, _>>();
    let mut service_ids = HashMap::<String, usize>::new();
    let mut services = vec![];
    let mut service_lines = vec![];
    let mut keys = vec![];
    let mut key_ids = HashMap::<String, usize>::new();
    let edges = if metrics {
        vec![]
    } else {
        graph
            .get("edges")
            .array()
            .iter()
            .map(|e| {
                let name = e.get("service").text();
                let r = runs.get(name).copied();
                let line = line_ids
                    .get(
                        r.filter(|r| r.get("parentLine").truth())
                            .map_or(name, |r| r.get("parentLine").text()),
                    )
                    .copied();
                let service = if let Some(i) = service_ids.get(name) {
                    *i
                } else {
                    let i = services.len();
                    service_ids.insert(name.into(), i);
                    services.push(e.get("service").clone());
                    service_lines.push(line);
                    i
                };
                let parts = unique(
                    &e.get("parts")
                        .array()
                        .iter()
                        .map(|p| p.get("line").clone())
                        .collect::<Vec<_>>(),
                )
                .iter()
                .filter_map(|id| line_ids.get(id.text()).copied())
                .collect();
                let tracks = if center {
                    let tracks = if e.get("tracks").truth() {
                        e.get("tracks").array().to_vec()
                    } else {
                        vec![e.get("track").clone()]
                    };
                    tracks
                        .iter()
                        .map(|id| {
                            let sign = r.map_or(1.0, |r| physical(s, r, id, 1.0));
                            let dir = if e.get("dir").truth() {
                                e.num("dir")
                            } else {
                                1.0
                            };
                            let key = track_key(id, sign * dir);
                            if let Some(i) = key_ids.get(&key) {
                                *i
                            } else {
                                let i = keys.len();
                                key_ids.insert(key.clone(), i);
                                keys.push(key);
                                i
                            }
                        })
                        .collect()
                } else {
                    vec![]
                };
                Edge {
                    service,
                    line,
                    parts,
                    tracks,
                    to: e.num("to") as usize,
                    km: e.num("km"),
                }
            })
            .collect::<Vec<_>>()
    };
    let mut accum = lines
        .iter()
        .map(|l| {
            let stops = unique(l.get("stops").array());
            let stations = stops
                .iter()
                .enumerate()
                .map(|(i, s)| (s.n() as usize, i))
                .collect();
            let len = stops.len();
            Line {
                riders: 0.0,
                revenue: 0.0,
                stops,
                stations,
                board: vec![0.0; len],
                alight: vec![0.0; len],
                demand: vec![0.0; keys.len()],
                present: vec![false; keys.len()],
                order: vec![],
                center_riders: 0.0,
                long: 0.0,
            }
        })
        .collect::<Vec<_>>();
    let lengths = if center {
        lines.iter().map(|l| km(s, l)).collect::<Vec<_>>()
    } else {
        vec![]
    };
    let mut usage = vec![0.0; services.len()];
    let mut run_seen = vec![0; services.len()];
    let mut used = vec![];
    let mut seen = vec![];
    let mut stat_seen = vec![0; lines.len()];
    let mut line_seen = vec![0; lines.len()];
    let mut distance = vec![0.0; lines.len()];
    let mut journeys = 0.0;
    let mut passenger_km = 0.0;
    let mut transfer_trips = 0.0;
    for (i, f) in profiles.iter().enumerate() {
        let stamp = i + 1;
        let scores = if f.hub { &hub } else { &normal };
        let scale = if f.ids.is_empty() {
            1.0
        } else {
            f.ids
                .iter()
                .fold(f64::INFINITY, |v, &id| min(v, scores[id]))
        };
        let trips = f.trips * scale;
        let amount = f.demand * scale;
        journeys += trips;
        passenger_km += trips * f.distance;
        if f.transfers > 0.0 {
            transfer_trips += trips;
        }
        if metrics {
            continue;
        }
        for &(id, fare) in &f.fares {
            if let Some(id) = map_fares[id] {
                accum[id].revenue += trips
                    * if fare == 0.0 || fare.is_nan() {
                        0.0
                    } else {
                        fare
                    };
            }
        }
        used.clear();
        seen.clear();
        for (j, &ix) in f.edges.iter().enumerate() {
            let e = &edges[ix];
            let origin = if j == 0 {
                f.from as usize
            } else {
                edges[f.edges[j - 1]].to
            };
            let board = j == 0 || edges[f.edges[j - 1]].service != e.service;
            let alight = j + 1 == f.edges.len() || edges[f.edges[j + 1]].service != e.service;
            for &id in &e.parts {
                let line = &mut accum[id];
                if stat_seen[id] != stamp {
                    stat_seen[id] = stamp;
                    used.push(id);
                }
                if board {
                    if let Some(&at) = line.stations.get(&origin) {
                        line.board[at] += trips;
                    }
                }
                if alight {
                    if let Some(&at) = line.stations.get(&e.to) {
                        line.alight[at] += trips;
                    }
                }
            }
            if !center {
                continue;
            }
            if let Some(id) = e.line {
                if line_seen[id] != stamp {
                    line_seen[id] = stamp;
                    seen.push(id);
                    distance[id] = 0.0;
                }
                distance[id] += e.km;
                let line = &mut accum[id];
                for &key in &e.tracks {
                    if !line.present[key] {
                        line.present[key] = true;
                        line.order.push(key);
                    }
                    line.demand[key] += amount;
                }
                if run_seen[e.service] != stamp {
                    run_seen[e.service] = stamp;
                    usage[e.service] += amount;
                }
            }
        }
        for &id in &used {
            accum[id].riders += trips;
        }
        for &id in &seen {
            accum[id].center_riders += amount;
            if distance[id] >= lengths[id] * 0.6 {
                accum[id].long += amount;
            }
        }
    }
    let mut totals = obj(&[]);
    let mut details = obj(&[]);
    for (i, line) in accum.into_iter().enumerate() {
        let stations = V::Object(
            line.stops
                .iter()
                .enumerate()
                .map(|(at, id)| {
                    (
                        jsstring(id),
                        obj(&[("board", n(line.board[at])), ("alight", n(line.alight[at]))]),
                    )
                })
                .collect(),
        );
        totals.set(
            lines[i].get("id").text(),
            obj(&[
                ("riders", n(line.riders)),
                ("revenue", n(line.revenue)),
                ("stations", stations),
            ]),
        );
        details.set(
            lines[i].get("id").text(),
            obj(&[
                (
                    "demand",
                    V::Object(
                        line.order
                            .iter()
                            .map(|&key| (keys[key].clone(), n(line.demand[key])))
                            .collect(),
                    ),
                ),
                (
                    "usage",
                    V::Object(
                        services
                            .iter()
                            .enumerate()
                            .filter(|(at, _)| service_lines[*at] == Some(i))
                            .map(|(at, id)| (id.text().into(), n(usage[at])))
                            .collect(),
                    ),
                ),
                ("riders", n(line.center_riders)),
                ("long", n(line.long)),
            ]),
        );
    }
    Aggregation {
        totals,
        details,
        journeys,
        passenger_km,
        transfer_trips,
    }
}
