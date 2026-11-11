//! Persistent revision routing. The host callback only encodes standard JSON/UTF-8.
use crate::{
    migration::Routing,
    value::{object, Value as V},
};
use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
};
pub(super) struct Context {
    router: Routing,
    pub names: Vec<String>,
    pub purposes: Vec<String>,
    pub ids: HashMap<String, usize>,
    sent: HashSet<(usize, String)>,
}
impl Context {
    pub fn new(v: V) -> Self {
        let mut router = Routing::new(v.get("graph").clone());
        router.seed(v.get("routes"));
        router.seed_trees(v.get("trees"));
        let mut out = Self {
            router,
            names: vec![],
            purposes: vec![],
            ids: HashMap::new(),
            sent: HashSet::new(),
        };
        out.update(&v);
        for p in v.get("paths").array() {
            out.sent
                .insert((p.array()[0].n() as usize, p.array()[1].text().to_string()));
        }
        out
    }
    pub fn update(&mut self, v: &V) {
        self.router.update_weights(v.get("weights"));
        self.names = v
            .get("names")
            .array()
            .iter()
            .map(|x| x.text().to_string())
            .collect();
        self.purposes = v
            .get("purposes")
            .array()
            .iter()
            .map(|x| x.text().to_string())
            .collect();
        self.ids = self
            .names
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i))
            .collect();
    }
    pub fn refresh(&mut self, rows: &[(usize, f64, f64)]) {
        let rows = V::Array(
            rows.iter()
                .map(|(id, h, d)| {
                    V::Array(vec![
                        V::String(self.names[*id].clone()),
                        V::Number(*h),
                        V::Number(*d),
                    ])
                })
                .collect(),
        );
        self.router.update_weights(&rows);
    }
    pub(super) fn seed_routes(&mut self,routes:&V,trees:&V){self.router.seed(routes);self.router.seed_trees(trees);}
    pub fn resolve(&mut self, source: &V, station: usize, id: usize) -> (Option<V>, V) {
        let next = self.router.route(source, station, id);
        let purpose = source.get("purpose").text().to_string();
        let trees = if self.sent.insert((station, purpose.clone())) {
            self.router.tree(station, &purpose).map_or(vec![], |data| {
                vec![V::Array(vec![
                    V::Number(station as f64),
                    V::String(purpose),
                    V::Array(data.iter().map(|x| V::Number(*x)).collect()),
                    V::Array(self.router.weights().into_iter().map(V::Number).collect()),
                ])]
            })
        } else {
            vec![]
        };
        let payload = object([
            ("journey", next.clone().unwrap_or(V::Null)),
            (
                "cacheKey",
                V::Array(vec![
                    V::Number(station as f64),
                    source.get("to").clone(),
                    source.get("purpose").clone(),
                    source.get("fare").clone(),
                ]),
            ),
            ("trees", V::Array(trees)),
        ]);
        (next, payload)
    }
}
pub(super) fn key(j: &V) -> Rc<str> {
    let fields = [
        "legs",
        "from",
        "to",
        "purpose",
        "back",
        "hub",
        "externalKind",
        "fare",
        "byLine",
    ];
    let value = V::Array(fields.iter().map(|k| j.get(k).clone()).collect());
    compact_key(&crate::diagnostics::json(&value))
}

// JSON encoders escape control characters, so these four dictionary codes cannot
// collide with input text. All remaining bytes (including key/property order) survive.
pub(super) fn compact_key(json: &str) -> Rc<str> {
    Rc::from(json.replace("\"service\":", "\u{1}").replace("\"dir\":", "\u{2}").replace("\"from\":", "\u{3}").replace("\"to\":", "\u{4}"))
}
#[cfg(test)]
mod identity_tests {
    #[test]
    fn dictionary_identity_is_lossless_for_escaped_values_and_unicode() {
        for raw in [r#"[{"service":"s1","dir":1,"from":0,"to":2},"住宅😀"]"#,r#"[{"service":"\"service\":","dir":-1,"from":1,"to":2},"\u0001"]"#] {
            let key=super::compact_key(raw);
            let restored=key.replace('\u{1}',"\"service\":").replace('\u{2}',"\"dir\":").replace('\u{3}',"\"from\":").replace('\u{4}',"\"to\":");
            assert_eq!(restored,raw);assert!(key.len()<raw.len());
        }
        assert_ne!(super::compact_key(r#"[{"from":1,"to":2}]"#),super::compact_key(r#"[{"from":2,"to":1}]"#));
    }
}
