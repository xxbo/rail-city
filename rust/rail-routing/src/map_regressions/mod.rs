//! Historical MAP59/60/62 answers, replayed through the native production owners.
//! The JSON is data only. Pool references share repeated worlds, line definitions
//! and account balances. Tagged scalars preserve absent values, NaN and signed zero.
use crate::{assets, bootstrap, editor, editor_support::*, forecast_session::ForecastOwner,
    json_codec, legacy, runtime_edit, value::Value as V};

fn expand_fixture(value: &V, pool: &[V]) -> V {
    if let V::Number(index) = value.get("$ref") {
        return pool[*index as usize].clone();
    }
    if let V::Number(index) = value.get("$base") {
        let mut next = pool[*index as usize].clone();
        for (key, val) in value.get("set").entries() {
            next.set(key, expand_fixture(val, pool));
        }
        return next;
    }
    match value.get("$scalar").text() {
        "undefined" => return V::Missing,
        "NaN" => return n(f64::NAN),
        "Infinity" => return n(f64::INFINITY),
        "-Infinity" => return n(f64::NEG_INFINITY),
        "-0" => return n(-0.0),
        "" => (),
        tag => panic!("unknown fixture scalar {tag}"),
    }
    match value {
        V::Array(rows) => arr(rows.iter().map(|r| expand_fixture(r, pool)).collect()),
        V::Object(rows) => V::Object(rows.iter().map(|(k, v)| (k.clone(), expand_fixture(v, pool))).collect()),
        other => other.clone(),
    }
}

fn cases(raw: &str, count: usize, mut run: impl FnMut(&V, &str)) {
    let source = json_codec::parse(raw).expect("invalid map regression corpus");
    let mut pool = Vec::new();
    for row in source.get("pool").array() {
        pool.push(expand_fixture(row, &pool));
    }
    let rows = source.get("cases").array();
    assert_eq!(rows.len(), count);
    for (index, raw) in rows.iter().enumerate() {
        let case = expand_fixture(raw, &pool);
        let name = format!("#{} {} {}", index + 1, case.get("state").get("region").text(), case.get("name").text());
        run(&case, &name);
    }
}

// Compare fields recursively so a failing oracle names the exact row and field.
// The MAP63 public save/accounting contract also freezes property order.
fn exact(actual: &V, expected: &V, path: &str, ordered: bool) {
    match (actual, expected) {
        (V::Shared(a), b) => exact(a, b, path, ordered),
        (a, V::Shared(b)) => exact(a, b, path, ordered),
        (V::Object(a), V::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: object size");
            if ordered {
                assert!(a.iter().map(|r| &r.0).eq(b.iter().map(|r| &r.0)), "{path}: field order {a:?} vs {b:?}");
            }
            for (key, val) in b {
                assert!(has(actual, key), "{path}: missing {key}");
                exact(actual.get(key), val, &format!("{path}.{key}"), ordered);
            }
        }
        (V::Array(a), V::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                exact(a, b, &format!("{path}[{i}]"), ordered);
            }
        }
        (V::Number(a), V::Number(b)) => assert!(a.to_bits() == b.to_bits() || a.is_nan() && b.is_nan(),
            "{path}: expected {b:?}, got {a:?}"),
        (V::Bool(a), V::Bool(b)) => assert_eq!(a, b, "{path}"),
        (V::String(a), V::String(b)) => assert_eq!(a, b, "{path}"),
        (V::Missing, V::Missing) | (V::Null, V::Null) => (),
        _ => panic!("{path}: expected {expected:?}, got {actual:?}"),
    }
}

#[test]
fn map60_service_compilation_matches_frozen_routes_and_errors() {
    let mut owner = ForecastOwner::default();
    cases(include_str!("map60.json"), 381, |case, name| {
        let state = case.get("state");
        let mut request = obj(&[("action", text("compiledServices")), ("state", state.clone()),
            ("minute", case.get("minute").clone())]);
        if case.get("op").text() == "compile" {
            request.set("line", state.get("services").array()[0].clone());
            request.set("sourceIndex", n(0.0));
            request.set("pattern", case.get("pattern").clone());
            request.set("index", case.get("index").clone());
        }
        let result = owner.handle(&request);
        exact(&result, case.get("expected"), name, false);
        exact(request.get("state"), state, name, true);
    });
}

#[test]
fn map60_precompiled_and_legacy_plans_preserve_services() {
    for (model, compiled) in [(8.0, false), (9.0, true)] {
        let state = obj(&[("routeModel", n(model)), ("operatingPlan", boolean(compiled)),
            ("services", arr(vec![obj(&[("id", text("original")), ("fleet", n(7.0))])]))]);
        let plan = expanded(&state, 480.0).unwrap();
        exact(plan.get("services"), state.get("services"), "passthrough", true);
    }
}

#[test]
fn map61_plan_validation_and_atomic_line_deletion() {
    cases(include_str!("map61.json"), 429, |case, name| {
        let state = case.get("state");
        if case.get("op").text() == "validate" {
            // Sparse JS arrays had a length and a separate list of present slots.
            // Replay their captured ABI packets, preserving holes independently of null.
            let valid = match case.get("wire") {
                V::Array(words) => crate::service_validation::valid(&words.iter().map(V::n).collect::<Vec<_>>()),
                _ => validate_plan(state),
            };
            exact(&boolean(valid), case.get("expected"), name, false);
            return;
        }
        let args = obj(&[("id", case.get("id").clone())]);
        let out = editor::run(obj(&[("state", state.clone()), ("op", text("removeLine")), ("args", args)]), &bootstrap::config());
        let mut next = state.clone();
        runtime_edit::apply(&mut next, out.get("patch"));
        if case.get("op").text() == "rejectRemove" {
            assert!(out.get("result").get("error").truth(), "{name}");
        } else {
            exact(out.get("result"), case.get("expected"), name, false);
        }
        exact(&next, case.get("after"), name, false);
    });
}

fn compat(action: &str, state: &V, command: &V) -> V {
    legacy::run(&obj(&[("action", text(action)), ("state", state.clone()),
        ("args", obj(&[("command", command.clone())]))]))
}

fn asset_request(state: &V, op: &str, args: &V) -> V {
    assets::run(&obj(&[("state", state.clone()), ("op", text(op)), ("args", args.clone())]), &bootstrap::config())
}

#[test]
fn map63_asset_transactions_match_frozen_receipts_and_complete_worlds() {
    let cfg = bootstrap::config();
    cases(include_str!("map63.json"), 535, |case, name| {
        let op = case.get("op").text();
        let state = case.get("state");
        let cmd = case.get("command");
        let mut next = state.clone();
        let result = match op {
            "init" => {
                next = compat("managementInit", state, cmd).get("state").clone();
                V::Missing
            }
            "change" | "rejectChange" => {
                let out = compat("assetChange", state, cmd);
                next = out.get("state").clone();
                out.get("result").clone()
            }
            "preview" => {
                let out = assets::run(&obj(&[("state", state.clone()), ("op", text("transaction")),
                    ("command", cmd.clone()), ("commit", boolean(false))]), &cfg);
                let mut projected = state.clone();
                runtime_edit::apply(&mut projected, out.get("patch"));
                let mut quote = out.get("quote").clone();
                quote.set("result", out.get("result").clone());
                quote.set("after", projected);
                quote
            }
            "finalize" | "rejectFinalize" => {
                // Historical editor callbacks stage their result before ledger settlement.
                let (mut staged, receipt) = if op == "finalize" {
                    let edit = editor::run(obj(&[("op", cmd.get("op").clone()), ("state", state.clone()),
                        ("args", cmd.get("args").clone())]), &cfg);
                    let mut staged = state.clone();
                    runtime_edit::apply(&mut staged, edit.get("patch"));
                    (staged, edit.get("result").clone())
                } else {
                    (case.get("staged").clone(), case.get("result").clone())
                };
                let out = assets::run(&obj(&[("op", text("finalize")), ("state", state.clone()),
                    ("after", staged.clone()), ("accounts", state.get("economy").clone()),
                    ("commit", boolean(true)), ("result", receipt.clone())]), &cfg);
                if out.get("result").get("error").truth() {
                    out.get("result").clone()
                } else {
                    runtime_edit::apply(&mut staged, out.get("patch"));
                    next = staged;
                    let mut quote = out.get("quote").clone();
                    quote.set("result", receipt.clone());
                    quote.set("after", next.clone());
                    let mut settled = receipt;
                    settled.set("quote", quote);
                    settled
                }
            }
            "purchase" | "vehicleValue" | "reserved" | "free" | "recommend" | "validateFleet" |
            "validateEconomy" | "facilityValue" => {
                let out = asset_request(state, op, case.get("args"));
                runtime_edit::apply(&mut next, out.get("patch"));
                out.get("result").clone()
            }
            _ => panic!("{name}: unknown operation {op}"),
        };
        if matches!(op, "rejectChange" | "rejectFinalize") {
            assert!(result.get("error").truth(), "{name}: expected rejection");
        } else if has(case, "expected") {
            exact(&result, case.get("expected"), name, true);
        }
        if has(case, "after") {
            exact(&next, case.get("after"), name, true);
        }
    });
}

#[test]
fn map63_mixed_depots_and_failed_dispatch_preserve_the_line() {
    let state = json_codec::parse(r#"{"depot":{"stock":{"6B":12}},"services":[{"id":"a","fleetManaged":true,"stockSpec":"6B","fleet":4},{"id":"b","stockSpec":"6B","fleet":8}]}"#).unwrap();
    let args = obj(&[("spec", text("6B"))]);
    assert_eq!(asset_request(&state, "reserved", &args).num("result"), 4.0);
    let mut line = json_codec::parse(r#"{"fleetManaged":true,"stockSpec":"6B","cars":6,"fleet":4,"dispatch":{"mode":"manual","manual":4,"offPeak":4,"peak":4},"patterns":[{},{}]}"#).unwrap();
    let before = line.clone();
    let dispatch = json_codec::parse(r#"{"mode":"manual","manual":2,"offPeak":2,"peak":2}"#).unwrap();
    assert!(assets::configure(&mut line, &dispatch, &bootstrap::config()).is_err());
    exact(&line, &before, "failed configure", true);
}

#[test]
fn map63_construction_stock_dispatch_facility_and_failed_purchase() {
    fn change(state: &mut V, kind: &str, op: &str, args: V) -> V {
        let cmd = obj(&[("kind", text(kind)), ("op", text(op)), ("args", args)]);
        let reply = compat("assetChange", state, &cmd);
        *state = reply.get("state").clone();
        reply.get("result").clone()
    }
    let cfg = bootstrap::config();
    let mut state = compat("managementInit", &bootstrap::empty("gba"), &V::Missing).get("state").clone();
    let args = json_codec::parse(r#"{"points":[{"x":600,"y":500,"nameSeed":0.1},{"x":640,"y":500,"nameSeed":0.2}],"options":{"stockSpec":"6B"}}"#).unwrap();
    let add = change(&mut state, "network", "addLine", args);
    assert!(!add.get("error").truth(), "{add:?}");
    let cash = state.get("economy").num("cash");
    let buy = obj(&[("spec", text("6B")), ("count", n(4.0))]);
    assert!(!change(&mut state, "fleet", "purchase", buy).get("error").truth());
    let dispatch = json_codec::parse(r#"{"dispatch":{"mode":"manual","manual":4,"offPeak":4,"peak":4}}"#).unwrap();
    let config = obj(&[("id", add.get("id").clone()), ("values", dispatch)]);
    assert!(!change(&mut state, "network", "configure", config).get("error").truth());
    let school = json_codec::parse(r#"{"kind":"school","point":{"x":700,"y":600},"land":true}"#).unwrap();
    assert!(!change(&mut state, "facility", "plan", school).get("error").truth());
    let before = state.clone();
    let invalid = obj(&[("spec", text("invalid")), ("count", n(4.0))]);
    assert!(change(&mut state, "fleet", "purchase", invalid).get("error").truth());
    exact(&state, &before, "failed purchase", true);
    assert_eq!(state.get("depot").get("stock").num("6B"), 4.0);
    let args = obj(&[("spec", text("6B"))]);
    assert_eq!(asset_request(&state, "free", &args).num("result"), 0.0);
    let price = cfg.get("specs").get("6B").num("price") * 4.0
        + cfg.get("facilityTypes").get("school").get("price").array()[0].n();
    assert_eq!(cash - state.get("economy").num("cash"), price);
    assert_eq!(state.get("urban").get("facilities").array()[0].get("kind").text(), "school");
    assert!(editor::validate(&state, &cfg) && editor::valid_fleet(&state, &cfg) && assets::economy_valid(&state));
}
