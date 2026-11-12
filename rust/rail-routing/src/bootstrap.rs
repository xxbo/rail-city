//! P3-1 source data and initialization. JS receives detached compatibility views.
use crate::{
    editor_support::*,
    queues::Read,
    value::{self, Value as V},
    CORE,
};
use std::{cell::RefCell, collections::HashMap, rc::Rc};
const FIELDS: [&str; 5] = ["people", "jobs", "shops", "industry", "leisure"];
thread_local! {
 static RAW: Rc<V> = {let b=include_bytes!("../data/bootstrap-v1.wire");let v=b.chunks_exact(8).map(|x|f64::from_le_bytes(x.try_into().unwrap())).collect::<Vec<_>>();Rc::new(value::read(&mut Read{v:&v,at:0}))};
 static CACHE: RefCell<HashMap<String,Rc<V>>> = RefCell::new(HashMap::new());
 static TERRAIN: RefCell<HashMap<String,HashMap<(i64,i64),Vec<usize>>>> = RefCell::new(HashMap::new());
 static ENTROPY: RefCell<(u64,f64)> = const{RefCell::new((0,0.0))};
}
pub(super) fn next_entropy() -> f64 {
    let v = crate::editor::entropy();
    ENTROPY.with(|s| {
        let mut s = s.borrow_mut();
        s.0 += 1;
        s.1 = v;
    });
    v
}
pub(super) fn entropy_status() -> V {
    ENTROPY.with(|s| {
        let s = s.borrow();
        obj(&[("draws", n(s.0 as f64)), ("last", n(s.1))])
    })
}
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "rail_math")]
extern "C" {
    #[link_name = "cos"]
    fn host_cos(v: f64) -> f64;
}
fn cos(v: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        return host_cos(v);
    }
    #[cfg(not(target_arch = "wasm32"))]
    v.cos()
}
fn raw() -> Rc<V> {
    RAW.with(Rc::clone)
}
fn cached(key: &str, make: impl FnOnce() -> V) -> Rc<V> {
    if let Some(v) = CACHE.with(|c| c.borrow().get(key).cloned()) {
        return v;
    }
    let v = Rc::new(make());
    CACHE.with(|c| c.borrow_mut().insert(key.into(), v.clone()));
    v
}
pub(super) fn region_id(v: &str) -> &str {
    if v == "gba" {
        "gba"
    } else {
        "tokyo"
    }
}
pub(super) fn regions() -> Rc<V> {
    cached("regions", || {
        let mut r = raw().get("regions").clone();
        let sx = 111.32 * cos(23.0 * std::f64::consts::PI / 180.0) / 0.045;
        let sy = 111.32 / 0.045;
        let g = r.get_mut("gba");
        g.set("sx", n(sx));
        g.set("sy", n(sy));
        g.set("width", n((4.2 * sx + 160.0).ceil()));
        g.set("height", n((3.1 * sy + 120.0).ceil()));
        r
    })
}
fn project(lat: f64, lon: f64, region: &str) -> V {
    let rs = regions();
    let r = rs.get(region_id(region));
    obj(&[
        ("x", n((lon - r.num("west")) * r.num("sx") + 80.0)),
        ("y", n((r.num("north") - lat) * r.num("sy") + 60.0)),
    ])
}
fn lat_lon(p: &V) -> V {
    let rs = regions();
    let r = rs.get(region_id(p.get("region").text()));
    obj(&[
        ("lon", n(r.num("west") + (p.num("x") - 80.0) / r.num("sx"))),
        ("lat", n(r.num("north") - (p.num("y") - 60.0) / r.num("sy"))),
    ])
}
pub(super) fn round(v: f64) -> f64 {
    if !v.is_finite() || v == 0.0 {
        return v;
    }
    let floor = v.floor();
    let rounded = if v - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && v < 0.0 {
        -0.0
    } else {
        rounded
    }
}
fn distance(a: &V, b: &V) -> f64 {
    crate::demand::hypot(a.num("x") - b.num("x"), a.num("y") - b.num("y")) * 0.045
}
pub(super) fn hubs(region: &str) -> Rc<V> {
    cached(&format!("hubs:{region}"), || {
        let source = raw();
        arr((if region == "gba" {
            source.get("gba").get("hubs")
        } else {
            source.get("tokyoHubs")
        })
        .array()
        .iter()
        .map(|h| {
            let mut h = h.clone();
            for (k, v) in project(h.num("lat"), h.num("lon"), region).entries() {
                h.set(k, v.clone());
            }
            h
        })
        .collect())
    })
}
fn daily(h: &V) -> f64 {
    match h.get("basis").text() {
        "daily-depart" => h.num("observed") * 2.0,
        "annual-both" => {
            h.num("observed")
                / if h.get("days").truth() {
                    h.num("days")
                } else {
                    365.0
                }
        }
        _ => h.num("observed"),
    }
}
pub(super) fn access(h: &V) -> V {
    if h.get("region").text() == "gba" {
        obj(&[
            (
                "railReference",
                n(match h.get("type").text() {
                    "airport" => 0.5,
                    "border" => 0.6,
                    "port" => 0.4,
                    _ => 0.6,
                }),
            ),
            (
                "note",
                text("大湾区铁路接驳倾向为游戏假设，非设施实测分担率；不使用日本机场职工参数"),
            ),
        ])
    } else {
        let r = raw();
        let a = r.get("hubAccess");
        if a.get(h.get("id").text()).truth() {
            a.get(h.get("id").text()).clone()
        } else if a.get(h.get("type").text()).truth() {
            a.get(h.get("type").text()).clone()
        } else {
            a.get("rail").clone()
        }
    }
}
pub(super) fn envelope(h: &V) -> V {
    let movements = daily(h);
    let total = movements * h.num("landside");
    obj(&[
        ("movements", n(movements)),
        ("landside", n(total)),
        ("visitorArrivals", n(total / 2.0 * h.num("visitor"))),
        ("visitorReturns", n(total / 2.0 * h.num("visitor"))),
        ("localDepartures", n(total / 2.0 * (1.0 - h.num("visitor")))),
        ("localReturns", n(total / 2.0 * (1.0 - h.num("visitor")))),
    ])
}
fn specs() -> V {
    let car = raw().get("balance").num("CAR");
    let mut out = obj(&[]);
    for cars in [4, 6, 8] {
        for ty in ["B", "A"] {
            let id = format!("{cars}{ty}");
            let a = ty == "A";
            out.set(
                &id,
                obj(&[
                    ("id", text(&id)),
                    ("cars", n(cars as f64)),
                    ("type", text(ty)),
                    ("width", n(if a { 3.0 } else { 2.8 })),
                    ("length", n(cars as f64 * if a { 23.0 } else { 20.0 })),
                    ("capacity", n(cars as f64 * if a { 310.0 } else { 240.0 })),
                    ("price", n(cars as f64 * car * if a { 1.3 } else { 1.0 })),
                ]),
            );
        }
    }
    out
}
fn add_seed(
    s: &mut V,
    owner: &str,
    name: &str,
    stops: Vec<V>,
    headway: f64,
    color: Option<&str>,
    owner_sensitive: bool,
) {
    let mut ids = vec![];
    for pair in stops.windows(2) {
        let a = pair[0].n();
        let b = pair[1].n();
        let found = s
            .get("tracks")
            .array()
            .iter()
            .find(|t| {
                (!owner_sensitive || t.get("owner").text() == owner)
                    && ((t.num("a") == a && t.num("b") == b)
                        || (t.num("a") == b && t.num("b") == a))
            })
            .cloned();
        let t = found.unwrap_or_else(|| {
            let id = format!("t{}", s.num("nextId") as u64);
            let km = distance(
                &s.get("nodes").array()[a as usize],
                &s.get("nodes").array()[b as usize],
            );
            s.set("nextId", n(s.num("nextId") + 1.0));
            let t = obj(&[
                ("id", text(&id)),
                ("a", n(a)),
                ("b", n(b)),
                ("owner", text(owner)),
                ("km", n(km)),
            ]);
            s.get_mut("tracks").array_mut().push(t.clone());
            t
        });
        ids.push(t.get("id").clone());
    }
    let mut l = obj(&[
        ("id", text(&format!("s{}", s.num("nextId") as u64))),
        ("name", text(name)),
        ("owner", text(owner)),
    ]);
    s.set("nextId", n(s.num("nextId") + 1.0));
    if let Some(c) = color {
        l.set("color", text(c));
    }
    for (k, v) in [
        ("stops", arr(stops)),
        ("trackIds", arr(ids)),
        ("headway", n(headway)),
        ("through", boolean(false)),
    ] {
        l.set(k, v);
    }
    s.get_mut("services").array_mut().push(l);
}
pub(super) fn seed() -> V {
    let r = raw();
    let nodes = r
        .get("seedRows")
        .array()
        .iter()
        .enumerate()
        .map(|(id, v)| {
            let a = v.array();
            let people = a[4].n();
            let jobs = a[5].n();
            obj(&[
                ("id", n(id as f64)),
                ("name", a[0].clone()),
                ("x", a[1].clone()),
                ("y", a[2].clone()),
                ("type", a[3].clone()),
                ("people", n(people)),
                ("jobs", n(jobs)),
                ("initialPeople", n(people)),
                ("initialJobs", n(jobs)),
                (
                    "housing",
                    n(if a[3].text() == "田园" {
                        14000.0
                    } else {
                        round(people * 1.7 + 2500.0)
                    }),
                ),
                ("growth", n(0.0)),
            ])
        })
        .collect();
    let mut s = obj(&[
        ("version", n(2.0)),
        ("quarter", n(0.0)),
        ("companies", r.get("companies").clone()),
        ("nodes", arr(nodes)),
        ("tracks", arr(vec![])),
        ("services", arr(vec![])),
        ("log", arr(vec![])),
        ("nextId", n(1.0)),
    ]);
    for (owner, name, st, h) in [
        ("jr", "山手环状线", vec![2, 3, 10, 11, 8, 5, 2], 5.0),
        ("aoba", "青葉本线", vec![14, 13, 12, 8], 8.0),
        ("metro", "都心穿越线", vec![8, 9, 7, 3], 6.0),
    ] {
        add_seed(
            &mut s,
            owner,
            name,
            st.into_iter().map(|x| n(x as f64)).collect(),
            h,
            None,
            false,
        );
    }
    s.set(
        "log",
        arr(vec![obj(&[
            ("q", n(0.0)),
            (
                "text",
                text("三家公司已开始运营。先试试调整票价、班次，或将青葉本线与都心穿越线直通。"),
            ),
        ])]),
    );
    s
}
fn tokyo_seed() -> V {
    let r = raw();
    let mut s = seed();
    s.set("region", text("tokyo"));
    s.set("world", r.get("tokyo").get("world").clone());
    s.set("tracks", arr(vec![]));
    s.set("services", arr(vec![]));
    s.set("nextId", n(1.0));
    s.set("log", arr(vec![]));
    let names = [
        "東京",
        "新宿",
        "渋谷",
        "池袋",
        "品川",
        "上野",
        "横浜",
        "大宮",
        "千葉",
        "立川",
        "八王子",
        "川崎",
        "北千住",
        "船橋",
        "柏",
        "成田空港",
        "羽田空港",
    ];
    let nodes = r
        .get("tokyo")
        .get("rows")
        .array()
        .iter()
        .enumerate()
        .map(|(id, v)| {
            let a = v.array();
            let hub = names.contains(&a[0].text());
            let people = if hub {
                18000.0
            } else if a[3].text() == "住宅" {
                14000.0
            } else {
                7000.0
            };
            let jobs = if hub {
                40000.0
            } else {
                match a[3].text() {
                    "办公" => 24000.0,
                    "商业" => 14000.0,
                    "教育" => 10000.0,
                    "工业" => 9000.0,
                    _ => 2500.0,
                }
            };
            let p = project(num(&a[2]), num(&a[1]), "tokyo");
            obj(&[
                ("id", n(id as f64)),
                ("name", a[0].clone()),
                ("x", n(round(p.num("x")))),
                ("y", n(round(p.num("y")))),
                ("type", a[3].clone()),
                ("hub", boolean(hub)),
                ("people", n(people)),
                ("jobs", n(jobs)),
                ("initialPeople", n(people)),
                ("initialJobs", n(jobs)),
                ("housing", n(people * 2.0)),
                ("growth", n(0.0)),
            ])
        })
        .collect();
    s.set("nodes", arr(nodes));
    for route in r.get("tokyo").get("routes").array() {
        let a = route.array();
        let stops = a[4]
            .text()
            .split(' ')
            .map(|name| {
                s.get("nodes")
                    .array()
                    .iter()
                    .find(|v| v.get("name").text() == name)
                    .unwrap()
                    .get("id")
                    .clone()
            })
            .collect();
        add_seed(
            &mut s,
            a[1].text(),
            a[0].text(),
            stops,
            a[3].n(),
            Some(a[2].text()),
            true,
        );
    }
    s
}
pub(super) fn places(region: &str) -> Rc<V> {
    cached(&format!("places:{region}"), || {
        let mut rows = hubs(region)
            .array()
            .iter()
            .map(|h| {
                obj(&[
                    (
                        "name",
                        text(h.get("name").text().split(" · ").next().unwrap()),
                    ),
                    ("x", h.get("x").clone()),
                    ("y", h.get("y").clone()),
                ])
            })
            .collect::<Vec<_>>();
        if region == "gba" {
            for row in raw().get("placeRows").array() {
                let a = row.array();
                let mut p = obj(&[("name", a[0].clone())]);
                for (k, v) in project(a[1].n(), a[2].n(), region).entries() {
                    p.set(k, v.clone());
                }
                rows.push(p);
            }
        } else {
            for node in tokyo_seed().get("nodes").array() {
                rows.push(obj(&[
                    ("name", node.get("name").clone()),
                    ("x", node.get("x").clone()),
                    ("y", node.get("y").clone()),
                ]));
            }
        }
        arr(rows)
    })
}
pub(super) fn config() -> Rc<V> {
    cached("config", || {
        let seed = seed();
        obj(&[
            ("specs", specs()),
            ("balance", raw().get("balance").clone()),
            ("facilityTypes", raw().get("facilityTypes").clone()),
            ("seedNodes", seed.get("nodes").clone()),
            (
                "identities",
                V::Object(
                    seed.get("companies")
                        .array()
                        .iter()
                        .map(|c| {
                            (
                                c.get("id").text().into(),
                                obj(&[
                                    ("name", c.get("name").clone()),
                                    ("short", c.get("short").clone()),
                                    ("color", c.get("color").clone()),
                                ]),
                            )
                        })
                        .collect(),
                ),
            ),
            (
                "regions",
                V::Object(
                    ["tokyo", "gba"]
                        .iter()
                        .map(|id| {
                            let r = regions();
                            let v = r.get(id);
                            (
                                id.to_string(),
                                obj(&[
                                    ("width", v.get("width").clone()),
                                    ("height", v.get("height").clone()),
                                ]),
                            )
                        })
                        .collect(),
                ),
            ),
            (
                "places",
                obj(&[
                    ("tokyo", (*places("tokyo")).clone()),
                    ("gba", (*places("gba")).clone()),
                ]),
            ),
        ])
    })
}
fn inside(lon: f64, lat: f64, p: &V) -> bool {
    let a = p.array();
    let mut hit = false;
    let mut j = a.len() - 1;
    for i in 0..a.len() {
        let x = a[i].array();
        let y = a[j].array();
        if (x[1].n() > lat) != (y[1].n() > lat)
            && lon < (y[0].n() - x[0].n()) * (lat - x[1].n()) / (y[1].n() - x[1].n()) + x[0].n()
        {
            hit = !hit;
        }
        j = i;
    }
    hit
}
fn land(lon: f64, lat: f64) -> bool {
    let r = raw();
    let g = r.get("gba");
    if g.get("islandPolys")
        .array()
        .iter()
        .any(|p| inside(lon, lat, p))
    {
        return true;
    }
    if inside(lon, lat, g.get("estuary")) {
        return false;
    }
    lat > if lon < 113.4 {
        21.70
    } else if lon < 113.62 {
        22.17
    } else if lon < 113.83 {
        22.72
    } else if lon < 114.05 {
        22.36
    } else if lon < 114.35 {
        22.30
    } else if lon < 114.62 {
        22.44
    } else {
        22.60
    }
}
pub(super) fn city(region: &str) -> Rc<V> {
    cached(&format!("city:{region}"), || {
        if region == "gba" {
            gba_city()
        } else {
            tokyo_city()
        }
    })
}
fn tokyo_city() -> V {
    let r = raw();
    let d = r.get("tokyoMetadata");
    let raw = include_bytes!("../data/tokyo-population-v1.bin");
    let mut cells = vec![];
    let mut totals = [0.0; 5];
    for row in 0..d.num("rows") as usize {
        for col in 0..d.num("cols") as usize {
            let i = (row * d.num("cols") as usize + col) * d.num("recordBytes") as usize;
            let lon = d.num("lon0") + col as f64 * d.num("stepLon");
            let lat = d.num("lat0") + row as f64 * d.num("stepLat");
            let area = (d.num("stepLat") * d.num("stepLon")).abs()
                * 111.32_f64.powi(2)
                * cos(lat * std::f64::consts::PI / 180.0);
            let people = raw[i] as f64 + 256.0 * raw[i + 1] as f64;
            let survey = raw[i + 3] as f64 / 255.0;
            let high = raw[i + 4] as f64 / 255.0 * area;
            let factory = raw[i + 5] as f64 / 255.0 * area;
            let park = raw[i + 7] as f64 / 255.0 * area;
            let public = raw[i + 8] as f64 / 255.0 * area;
            let values = [
                people,
                round(people * 0.25 + high * 18000.0 + factory * 5000.0 + public * 5000.0),
                round(people * 0.04 + high * 5000.0),
                round(factory * 5000.0),
                round(people * 0.05 + park * 5000.0 + public * 3000.0),
            ];
            let mut c = obj(&[
                ("id", text(&format!("{row}:{col}"))),
                ("x", n((lon - 139.15) * 2000.0 + 80.0)),
                ("y", n((36.04 - lat) * 2470.0 + 60.0)),
                ("w", n(d.num("stepLon") * 2000.0)),
                ("h", n(-d.num("stepLat") * 2470.0)),
                ("area", n(area)),
                ("populationValid", boolean(raw[i + 2] == 1)),
                ("survey", n(survey)),
                ("factory", n(factory)),
                ("high", n(high)),
                ("park", n(park)),
            ]);
            for (k, value) in FIELDS.iter().zip(values) {
                c.set(k, n(value));
            }
            for i in 0..5 {
                totals[i] += values[i];
            }
            cells.push(c);
        }
    }
    let mut metadata = d.clone();
    metadata.set("raw", arr(raw.iter().map(|x| n(*x as f64)).collect()));
    obj(&[
        ("cells", arr(cells)),
        (
            "totals",
            obj(&FIELDS
                .iter()
                .enumerate()
                .map(|(i, k)| (*k, n(totals[i])))
                .collect::<Vec<_>>()),
        ),
        ("cell", n(2000.0 / 120.0)),
        ("area", n(0.7)),
        ("metadata", metadata),
    ])
}
fn gba_city() -> V {
    let r = raw();
    let rs = regions();
    let cfg = rs.get("gba");
    let lon0 = cfg.num("west") + 0.01;
    let lat0 = cfg.num("north") - 0.009;
    let mut cells = vec![];
    for row in 0..173 {
        for col in 0..210 {
            let lon = lon0 + col as f64 * 0.02;
            let lat = lat0 + row as f64 * (-0.018);
            let p = project(lat, lon, "gba");
            cells.push(obj(&[
                ("id", text(&format!("{row}:{col}"))),
                ("x", p.get("x").clone()),
                ("y", p.get("y").clone()),
                ("lon", n(lon)),
                ("lat", n(lat)),
                ("w", n(0.02 * cfg.num("sx"))),
                ("h", n(0.018 * cfg.num("sy"))),
                (
                    "area",
                    n(0.02 * 0.018 * 111.32_f64.powi(2) * cos(lat * std::f64::consts::PI / 180.0)),
                ),
                ("land", boolean(land(lon, lat))),
                ("people", n(0.0)),
                ("jobs", n(0.0)),
                ("shops", n(0.0)),
                ("industry", n(0.0)),
                ("leisure", n(0.0)),
                ("factory", n(0.0)),
                ("survey", n(0.0)),
                ("populationValid", boolean(false)),
                ("modelled", boolean(true)),
            ]));
        }
    }
    let mut by_city = obj(&[]);
    for city in r.get("gba").get("cities").array() {
        let mut weights = vec![[0.0; 3]; cells.len()];
        let mut total = 0.0;
        for (i, c) in cells.iter().enumerate() {
            if !c.get("land").truth() {
                continue;
            }
            for centre in city.get("centres").array() {
                let a = centre.array();
                let dx = (c.num("lon") - a[0].n()) * 102.5;
                let dy = (c.num("lat") - a[1].n()) * 111.32;
                let d2 = (dx * dx + dy * dy) / (a[3].n() * a[3].n());
                if d2 > 12.0 {
                    continue;
                }
                let x = a[2].n() * crate::demand::raw_exp(-d2 / 2.0) * c.num("area")
                    / (a[3].n() * a[3].n());
                weights[i][0] += x;
                weights[i][1] += x * a[4].n();
                weights[i][2] += x * a[5].n();
            }
            total += weights[i][0];
        }
        let mut allocated = 0.0;
        for (i, c) in cells.iter_mut().enumerate() {
            let w = weights[i];
            if w[0] == 0.0 {
                continue;
            }
            let pop = city.num("population");
            let n0 = pop * w[0] / total;
            let j = pop * 0.49 * w[1] / total;
            let f = pop * 0.18 * w[2] / total;
            for (k, x) in [
                ("people", n0),
                ("jobs", j),
                ("shops", j * 0.16 + n0 * 0.035),
                ("leisure", n0 * 0.08 + j * 0.07),
                ("industry", f),
                ("factory", f / 9000.0),
            ] {
                c.set(k, n(c.num(k) + x));
            }
            allocated += n0;
        }
        by_city.set(city.get("name").text(), n(allocated));
    }
    let mut totals = obj(&[]);
    for k in FIELDS {
        totals.set(k, n(cells.iter().map(|c| c.num(k)).sum()));
    }
    for c in &mut cells {
        c.set("factory", n((c.num("area") * 0.65).min(c.num("factory"))));
    }
    let mut metadata = r.get("gba").get("metadata").clone();
    metadata.set("populationSum", totals.get("people").clone());
    obj(&[
        ("cells", arr(cells)),
        ("totals", totals),
        ("cell", n(0.02 * cfg.num("sx"))),
        ("area", n(4.0)),
        ("byCity", by_city),
        ("metadata", metadata),
    ])
}
fn terrain(region: &str, p: &V) -> V {
    let base = city(region);
    TERRAIN.with(|indices| {
        let mut indices = indices.borrow_mut();
        let index = indices.entry(region.into()).or_insert_with(|| {
            let mut bins: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
            for (i, c) in base.get("cells").array().iter().enumerate() {
                bins.entry((
                    (c.num("x") / 60.0).floor() as i64,
                    (c.num("y") / 60.0).floor() as i64,
                ))
                .or_default()
                .push(i);
            }
            bins
        });
        let x = (p.num("x") / 60.0).floor() as i64;
        let y = (p.num("y") / 60.0).floor() as i64;
        let mut best = V::Null;
        let mut d = f64::INFINITY;
        for a in -1..=1 {
            for b in -1..=1 {
                if let Some(ids) = index.get(&(x + a, y + b)) {
                    for i in ids {
                        let c = &base.get("cells").array()[*i];
                        let q =
                            crate::demand::hypot(c.num("x") - p.num("x"), c.num("y") - p.num("y"));
                        if q < d {
                            d = q;
                            best = c.clone();
                        }
                    }
                }
            }
        }
        best
    })
}
pub(super) fn buildable(s: &V, p: &V) -> bool {
    buildable_input(s, p, &V::Missing)
}
fn terrain_custom(base: &V, p: &V) -> V {
    let x = (p.num("x") / 60.0).floor();
    let y = (p.num("y") / 60.0).floor();
    let mut best = V::Null;
    let mut distance = f64::INFINITY;
    for a in -1..=1 {
        for b in -1..=1 {
            for c in base.get("cells").array() {
                if (c.num("x") / 60.0).floor() != x + a as f64
                    || (c.num("y") / 60.0).floor() != y + b as f64
                {
                    continue;
                }
                let d = crate::demand::hypot(c.num("x") - p.num("x"), c.num("y") - p.num("y"));
                if d < distance {
                    distance = d;
                    best = c.clone();
                }
            }
        }
    }
    best
}
pub(super) fn buildable_input(s: &V, p: &V, base: &V) -> bool {
    if !finite(p.get("x"))
        || !finite(p.get("y"))
        || p.num("x") < 25.0
        || p.num("y") < 25.0
        || p.num("x") > s.get("world").num("width") - 25.0
        || p.num("y") > s.get("world").num("height") - 25.0
    {
        return false;
    }
    let region = s.get("region").text();
    let c = if matches!(base, V::Missing) {
        terrain(region, p)
    } else {
        terrain_custom(base, p)
    };
    if matches!(c, V::Null) {
        return false;
    }
    if hubs(region)
        .array()
        .iter()
        .any(|h| h.get("type").text() != "port" && distance(h, p) < 0.6)
    {
        return true;
    }
    if region == "gba" {
        let ll = lat_lon(&obj(&[
            ("region", text("gba")),
            ("x", p.get("x").clone()),
            ("y", p.get("y").clone()),
        ]));
        land(ll.num("lon"), ll.num("lat"))
    } else {
        c.get("populationValid").truth() || c.num("survey") > 0.01
    }
}

fn apply(s: &mut V, out: &V) {
    let before = s.clone();
    for row in out.get("patch").array() {
        let a = row.array();
        let key = a[0].text();
        match a[1].n() as u32 {
            0 => (),
            1 => s.set(
                key,
                arr(a[2]
                    .array()
                    .iter()
                    .map(|r| {
                        let x = r.array();
                        if x[0].n() >= 0.0 {
                            before.get(key).array()[x[0].n() as usize].clone()
                        } else {
                            x[1].clone()
                        }
                    })
                    .collect()),
            ),
            _ => s.set(key, a[2].clone()),
        }
    }
}
pub(super) fn empty(region: &str) -> V {
    let mut s = seed();
    let id = region_id(region);
    s.set("region", text(id));
    s.set("routeModel", n(9.0));
    let cfg = regions();
    let r = cfg.get(id);
    s.set(
        "world",
        obj(&[
            ("width", r.get("width").clone()),
            ("height", r.get("height").clone()),
        ]),
    );
    for k in ["nodes", "tracks", "services", "log"] {
        s.set(k, arr(vec![]));
    }
    s.set("nextId", n(1.0));
    crate::editor::command(&mut s, "defaults", &obj(&[]), &config()).unwrap();
    s
}
pub(super) fn upgrade(mut s: V) -> V {
    if s.num("version") == 1.0 {
        s.set("version", n(2.0));
        let tracks = s.get("tracks").clone();
        for l in s.get_mut("services").array_mut() {
            if l.get("through").truth() {
                l.set(
                    "operators",
                    arr(l
                        .get("trackIds")
                        .array()
                        .iter()
                        .map(|id| {
                            tracks
                                .array()
                                .iter()
                                .find(|t| same(t.get("id"), id))
                                .map_or(V::Missing, |t| t.get("owner").clone())
                        })
                        .collect()),
                );
            }
        }
    }
    s
}
pub(super) fn urban_init(s: &mut V) {
    if !s.get("urban").truth() {
        let minute = if matches!(s.get("economy").get("minute"), V::Missing | V::Null) {
            420.0
        } else {
            s.get("economy").num("minute")
        };
        s.set(
            "urban",
            obj(&[
                ("version", n(19.0)),
                ("revision", n(0.0)),
                ("step", n(0.0)),
                ("lastMinute", n(minute)),
                ("started", n(minute)),
                ("cells", obj(&[])),
                ("facilities", arr(vec![])),
                ("nextId", n(1.0)),
                ("history", arr(vec![])),
                (
                    "totals",
                    obj(&FIELDS.iter().map(|k| (*k, n(0.0))).collect::<Vec<_>>()),
                ),
            ]),
        );
    }
}
pub(super) fn ridership_init(s: &mut V, enable: bool) {
    let minute = if s.get("economy").get("minute").truth() {
        s.get("economy").num("minute")
    } else {
        420.0
    };
    ridership_init_at(s, enable, minute);
}
pub(super) fn ridership_init_at(s: &mut V, enable: bool, minute: f64) {
    if s.num("routeModel") != 9.0 {
        return;
    }
    let day = crate::history::day(minute);
    let lines = if s.get("baseLines").truth() {
        s.get("baseLines").clone()
    } else {
        s.get("services").clone()
    };
    let invalid = {
        let q = s.get("ridership");
        !q.truth()
            || q.num("version") != 14.0
            || !q.get("lines").truth()
            || !q.get("current").truth()
            || !q.get("records").truth()
            || !matches!(q.get("history"), V::Array(_))
            || !matches!(q.get("hour"), V::Array(_))
    };
    if invalid {
        let mut current = obj(&[
            ("number", n(day)),
            ("revenue", n(0.0)),
            ("operating", n(0.0)),
            ("passengerKm", n(0.0)),
            ("metricsSince", n(420.0 + (day - 1.0) * 1440.0)),
            ("attempted", n(0.0)),
            ("completed", n(0.0)),
            ("rejected", n(0.0)),
            ("waitMinutes", n(0.0)),
            ("boarded", n(0.0)),
            ("lines", obj(&[])),
            ("stations", obj(&[])),
        ]);
        let _ = &mut current;
        let mut rows = obj(&[]);
        for l in lines.array() {
            rows.set(l.get("id").text(), ridership_line(minute, true));
        }
        s.set(
            "ridership",
            obj(&[
                ("version", n(14.0)),
                ("lines", rows),
                ("current", current),
                ("history", arr(vec![])),
                ("hour", arr(vec![])),
                (
                    "records",
                    obj(&[
                        ("bestDay", n(0.0)),
                        ("bestDayNumber", n(0.0)),
                        ("bestHour", n(0.0)),
                        ("bestHourMinute", n(0.0)),
                        ("totalCompleted", n(0.0)),
                    ]),
                ),
                ("lastMinute", n(minute)),
            ]),
        );
    }
    let q = s.get_mut("ridership");
    if !finite(q.get("records").get("totalPassengerKm")) {
        q.get_mut("records").set("totalPassengerKm", n(0.0));
    }
    let d = q.get_mut("current");
    if !finite(d.get("revenue")) {
        for k in ["revenue", "operating", "passengerKm"] {
            d.set(k, n(0.0));
        }
        d.set("metricsSince", n(minute));
    }
    if d.num("number") == day {
        let base = 420.0 + (day - 1.0) * 1440.0;
        if minute >= base && minute <= base + 1440.0 {
            let f = d.get("flow");
            if !f.truth()
                || f.num("version") != 1.0
                || ["entered", "boarded", "completed"]
                    .iter()
                    .any(|k| !matches!(f.get(k),V::Array(v)if v.len()==96))
            {
                d.set(
                    "flow",
                    obj(&[
                        ("version", n(1.0)),
                        ("since", n(minute)),
                        ("through", n(minute)),
                        ("entered", arr(vec![n(0.0); 96])),
                        ("boarded", arr(vec![n(0.0); 96])),
                        ("completed", arr(vec![n(0.0); 96])),
                    ]),
                );
            }
            let f = d.get_mut("flow");
            f.set(
                "through",
                n(f.num("through").max((base + 1440.0).min(minute))),
            );
        }
    }
    for l in lines.array() {
        if !q.get("lines").get(l.get("id").text()).truth() {
            q.get_mut("lines")
                .set(l.get("id").text(), ridership_line(minute, false));
        }
    }
    if enable && q.num("model") != 22.0 {
        q.set("model", n(22.0));
        if let V::Object(rows) = q.get_mut("lines") {
            for (_, r) in rows {
                r.set("satisfaction", n(0.7));
                r.set("scores", V::Null);
                r.set("feedbackMinute", V::Null);
            }
        }
    }
}
fn ridership_line(minute: f64, migrated: bool) -> V {
    obj(&[
        ("opened", n(minute)),
        ("awareness", n(if migrated { 1.0 } else { 0.55 })),
        ("trust", n(1.0)),
        ("serviceDays", n(if migrated { 30.0 } else { 0.0 })),
        ("migrated", boolean(migrated)),
        ("bestDay", n(0.0)),
        ("attempted", n(0.0)),
        ("lost", n(0.0)),
        ("wait", n(0.0)),
        ("boarded", n(0.0)),
    ])
}
fn asset_mutate(s: &mut V, op: &str) {
    let out = crate::assets::run(
        &obj(&[("state", s.clone()), ("op", text(op)), ("args", obj(&[]))]),
        &config(),
    );
    apply(s, &out);
}
pub(super) fn urban_call(op: usize, s: &V, extra: Vec<(&'static str, V)>) -> V {
    let mut v = obj(&[
        ("state", s.clone()),
        ("types", raw().get("facilityTypes").clone()),
        (
            "hubs",
            arr(hubs(s.get("region").text())
                .array()
                .iter()
                .map(|h| {
                    let mut h = h.clone();
                    h.set("daily", n(daily(&h)));
                    h
                })
                .collect()),
        ),
    ]);
    for (k, x) in extra {
        v.set(k, x);
    }
    crate::urban::run(op, &v)
}
fn merge(target: &mut V, patch: &V) {
    for (k, v) in patch.entries() {
        target.set(k, v.clone());
    }
}
pub(super) fn initialize(mut s: V) -> V {
    let cfg = config();
    crate::editor::command(&mut s, "upgrade", &obj(&[]), &cfg).unwrap();
    ridership_init(&mut s, false);
    if !s.get("economy").truth()
        || s.get("economy").num("balanceVersion") != raw().get("balance").num("VERSION")
    {
        asset_mutate(&mut s, "init");
    }
    let migrated_urban = !s.get("urban").truth();
    urban_init(&mut s);
    let mut blocked = false;
    if !crate::save::urban(&s, &cfg) {
        del(&mut s, "urban");
        urban_init(&mut s);
        blocked = true;
    }
    if !crate::assets::economy_valid(&s) {
        del(&mut s, "economy");
        ridership_init(&mut s, false);
        asset_mutate(&mut s, "init");
        blocked = true;
    }
    let region = s.get("region").text().to_string();
    let migrated_facilities = s.get("urban").get("facilityMode").text() != "automatic";
    if migrated_facilities {
        asset_mutate(&mut s, "municipalTransfer");
        let source = places(&region)
            .array()
            .iter()
            .filter(|p| {
                buildable(&s, p) && !hubs(&region).array().iter().any(|h| distance(h, p) < 0.25)
            })
            .map(|p| {
                obj(&[
                    ("x", p.get("x").clone()),
                    ("y", p.get("y").clone()),
                    ("name", p.get("name").clone()),
                ])
            })
            .collect();
        let candidates = urban_call(11, &s, vec![("places", arr(source))]);
        let u = s.get_mut("urban");
        u.set("autoCandidates", candidates);
        u.set("facilityMode", text("automatic"));
        u.set("revision", n(u.num("revision") + 1.0));
        let patch = urban_call(4, &s, vec![]);
        merge(s.get_mut("urban"), &patch);
    }
    if !s.get("urban").get("development").truth() {
        let source = places(&region)
            .array()
            .iter()
            .filter(|p| buildable(&s, p))
            .cloned()
            .collect();
        let d = urban_call(
            10,
            &s,
            vec![("region", text(&region)), ("places", arr(source))],
        );
        let u = s.get_mut("urban");
        u.set("development", d);
        u.set("revision", n(u.num("revision") + 1.0));
    }
    ridership_init(&mut s, true);
    obj(&[
        ("state", s),
        ("migratedUrban", boolean(migrated_urban)),
        ("migratedFacilities", boolean(migrated_facilities)),
        ("blocked", boolean(blocked)),
    ])
}
pub(super) fn startup(input: &V) -> V {
    let region = region_id(input.get("region").text());
    let mut s = empty(region);
    let mut playing = true;
    let mut speed = 6.0;
    let mut runtime = V::Null;
    let mut records = obj(&[]);
    let mut blocked = input.get("readError").truth();
    let mut status = if blocked {
        "本地数据库读取失败，已禁止自动覆盖"
    } else {
        ""
    };
    let raw = if input.get("stored").get("present").truth() {
        input.get("stored")
    } else if region == "tokyo" && input.get("legacy6").get("present").truth() {
        input.get("legacy6")
    } else if region == "tokyo" {
        input.get("legacy4")
    } else {
        &V::Missing
    };
    if raw.get("error").truth() {
        blocked = true;
        status = "本地数据库读取失败，已禁止自动覆盖";
    } else if raw.get("present").truth() {
        let v = raw.get("value");
        let accepted = crate::save::run(
            &obj(&[
                ("op", text("checkpoint")),
                ("value", v.clone()),
                ("region", text(region)),
            ]),
            &config(),
        );
        if accepted.get("valid").truth() {
            let kind = accepted.num("kind");
            s = if kind == 0.0 {
                v.clone()
            } else {
                v.get("state").clone()
            };
            if kind != 7.0 {
                crate::editor::command(
                    &mut s,
                    "removePreset",
                    &obj(&[("seed", tokyo_seed())]),
                    &config(),
                )
                .unwrap();
            } else {
                records = accepted.get("records").clone();
                if let V::Bool(b) = v.get("playing") {
                    playing = *b;
                }
                if [1.0, 3.0, 6.0, 12.0, 24.0].contains(&v.num("speed")) {
                    speed = v.num("speed");
                }
                if accepted.get("useRuntime").truth() {
                    runtime = v.get("runtime").clone();
                }
            }
        } else {
            blocked = true;
            status = "存档版本或运行数据校验失败，已禁止自动覆盖";
        }
    }
    let mut out = initialize(s);
    out.set("blocked", boolean(blocked || out.get("blocked").truth()));
    out.set("status", text(status));
    out.set("playing", boolean(playing));
    out.set("speed", n(speed));
    out.set("runtime", runtime);
    out.set("records", records);
    out
}
pub(super) fn run(input: &V) -> Rc<V> {
    let region = region_id(input.get("region").text());
    let op = input.get("op").text();
    match op {
        "installConfig" => {
            crate::editor::install_config((*config()).clone());
            Rc::new(boolean(true))
        }
        "config" => config(),
        "regions" => regions(),
        "city" => city(region),
        "places" => places(region),
        "hubs" => hubs(region),
        "settings" => cached("settings", || {
            obj(&[
                ("tariffs", crate::tariffs::settings()),
                ("balance", raw().get("balance").clone()),
                ("specs", specs()),
                ("types", raw().get("facilityTypes").clone()),
                ("developmentKinds", raw().get("developmentKinds").clone()),
                ("regions", (*regions()).clone()),
            ])
        }),
        "startup" => Rc::new(startup(input)),
        "initialize" => Rc::new(initialize(input.get("state").clone())),
        _ => Rc::new(match op {
            "tokyoSource" => {
                let mut d = raw().get("tokyoMetadata").clone();
                d.set(
                    "raw",
                    arr(include_bytes!("../data/tokyo-population-v1.bin")
                        .iter()
                        .map(|v| n(*v as f64))
                        .collect()),
                );
                d
            }
            "gbaSource" => raw().get("gba").clone(),
            "selectRegion" => text(
                if ["tokyo", "gba"].contains(&input.get("selected").text()) {
                    input.get("selected").text()
                } else if input.get("last").text() == "gba" {
                    "gba"
                } else {
                    "tokyo"
                },
            ),
            "runtimePolicy" => {
                let minute = input.get("state").get("economy").num("minute");
                obj(&[
                    (
                        "reuse",
                        boolean(
                            input.get("restored").truth()
                                && !((input.num("runtimeMinute") - minute).abs() > 0.01),
                        ),
                    ),
                    ("minute", n(minute)),
                    ("warm", boolean(minute == 420.0)),
                    (
                        "rebase",
                        boolean(
                            input.get("migratedFacilities").truth()
                                || (input.get("hasSaved").truth()
                                    && input.num("connectionModel") == 36.0),
                        ),
                    ),
                ])
            }
            "tokyoWorld" => raw().get("tokyo").get("world").clone(),
            "tokyoProject" => {
                let p = project(input.num("lat"), input.num("lon"), "tokyo");
                obj(&[("x", n(round(p.num("x")))), ("y", n(round(p.num("y"))))])
            }
            "seed" => seed(),
            "tokyoSeed" => tokyo_seed(),
            "empty" => empty(region),
            "upgrade" => upgrade(input.get("state").clone()),
            "project" => project(input.num("lat"), input.num("lon"), region),
            "latLon" => lat_lon(input),
            "hubDaily" => n(daily(input.get("hub"))),
            "hubAccess" => access(input.get("hub")),
            "hubEnvelope" => envelope(input.get("hub")),
            "land" => boolean(land(input.num("lon"), input.num("lat"))),
            "buildable" => boolean(buildable_input(
                input.get("state"),
                input.get("point"),
                input.get("base"),
            )),
            "terrain" => {
                if matches!(input.get("base"), V::Missing) {
                    terrain(input.get("geoId").text(), input.get("point"))
                } else {
                    terrain_custom(input.get("base"), input.get("point"))
                }
            }
            "rngStatus" => entropy_status(),
            "random" => n(crate::editor::random()),
            "urbanInit" => {
                let mut s = input.get("state").clone();
                urban_init(&mut s);
                s.get("urban").clone()
            }
            _ => obj(&[("error", text("未知的初始化请求"))]),
        }),
    }
}
#[no_mangle]
pub extern "C" fn bootstrap_abi() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn bootstrap_run() -> *const f64 {
    let input = CORE.with(|c| {
        value::read(&mut Read {
            v: &c.borrow().input,
            at: 0,
        })
    });
    let out = run(&input);
    CORE.with(|c| {
        let mut c = c.borrow_mut();
        c.output = value::write(&out);
        c.output.as_ptr()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_session_initializes_without_host_world_or_config() {
        let mut host = crate::session::SessionHost::default();
        let wire = host.request(&value::write(&obj(&[
            ("protocolVersion", n(1.0)),
            ("op", text("start")),
            ("region", text("gba")),
        ])));
        let result = value::read(&mut Read { v: &wire, at: 0 });
        assert!(result.get("ok").truth());
        let s = result.get("result").get("state");
        assert_eq!(s.get("region").text(), "gba");
        assert_eq!(s.get("economy").num("cash"), 5e9);
        assert_eq!(
            s.get("urban")
                .get("development")
                .get("projects")
                .array()
                .len(),
            12
        );
        assert_eq!(s.get("ridership").num("model"), 22.0);
    }
    #[test]
    fn source_bytes_terrain_and_allocation_are_native() {
        assert_eq!(city("tokyo").get("cells").array().len(), 18025);
        let gba = city("gba");
        assert_eq!(gba.get("cells").array().len(), 36330);
        let input = raw();
        let expected: f64 = input
            .get("gba")
            .get("cities")
            .array()
            .iter()
            .map(|c| c.num("population"))
            .sum();
        assert!((gba.get("totals").num("people") - expected).abs() < 1e-5);
        assert_eq!(config().get("specs").get("6B").num("capacity"), 1440.0);
        assert_eq!(seed().get("nodes").array().len(), 25);
    }
}

#[no_mangle]
pub extern "C" fn bootstrap_packed() -> *const f64 {
    let input = CORE.with(|c| {
        let c = c.borrow();
        value::read_packed(&c.input, &c.cycle_bytes)
    });
    let out = match input {
        Some(input) => run(&input),
        None => Rc::new(obj(&[("error", text("INVALID_WIRE"))])),
    };
    let (v, b) = value::write_packed(&out);
    CORE.with(|c| {
        let mut c = c.borrow_mut();
        c.output = v;
        c.cycle_bytes = b;
        c.output.as_ptr()
    })
}
#[no_mangle]
pub extern "C" fn bootstrap_bytes_ptr() -> *const u8 {
    CORE.with(|c| c.borrow().cycle_bytes.as_ptr())
}
#[no_mangle]
pub extern "C" fn bootstrap_bytes_len() -> usize {
    CORE.with(|c| c.borrow().cycle_bytes.len())
}
