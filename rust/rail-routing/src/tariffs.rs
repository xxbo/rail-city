//! Distance fares in the game's internal currency units.
use crate::{editor_support::*, value::Value as V};

pub(super) const LIMITS: [f64; 6] = [6.0, 11.0, 19.0, 27.0, 40.0, 999.0];
pub(super) const PRICES: [f64; 6] = [180.0, 210.0, 260.0, 300.0, 330.0, 400.0];

pub(super) const MIN_PRICE: f64 = 20.0;
pub(super) const MAX_PRICE: f64 = 3000.0;

pub(super) fn band(km: f64) -> Option<usize> {
    if km <= 1e-9 { return None; }
    let rounded = (km - 1e-8).ceil();
    Some(LIMITS.iter().position(|limit| rounded <= *limit).unwrap_or(LIMITS.len() - 1))
}

pub(super) fn settings() -> V {
    obj(&[("limits", arr(LIMITS.map(n).to_vec())), ("prices", arr(PRICES.map(n).to_vec())),
        ("min", n(MIN_PRICE)), ("max", n(MAX_PRICE))])
}

pub(super) fn bands(line: &V) -> V {
    if line.get("fareBands").truth() { line.get("fareBands").clone() }
    else { arr(PRICES.map(n).to_vec()) }
}

pub(super) fn price(line: &V, index: usize) -> V {
    if line.get("fareBands").truth() {
        line.get("fareBands").array().get(index).cloned().unwrap_or(V::Missing)
    } else { n(PRICES[index]) }
}

pub(super) fn quote(line: &V, km: f64) -> V {
    band(km).map_or(n(0.0), |i| price(line, i))
}

pub(super) fn feedback(line: &V, length: f64) -> [f64; 2] {
    let index = band(length.clamp(1.0, 10.0)).unwrap();
    [price(line, index).n(), PRICES[index]]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_and_graph_prices_follow_the_same_boundary_as_the_quote() {
        let custom = [190.0,220.0,270.0,310.0,340.0,410.0];
        let line = obj(&[("id",text("A")),("fareBands",arr(custom.map(n).to_vec()))]);
        let world = obj(&[("services",arr(vec![line.clone()]))]);
        let prices = crate::forecast_session::graph_prices(&world,&arr(vec![text("A"),text("missing")]));
        let values = prices.array().iter().map(V::n).collect::<Vec<_>>();
        assert_eq!(&values[..6], &custom);
        assert_eq!(&values[6..], &PRICES);
        for (km, index) in [(6.0,0),(6.000000001,0),(6.0001,1),(11.0001,2),(1200.0,5)] {
            assert_eq!(quote(&line,km).n(),custom[index]);
            assert_eq!(crate::fare(&custom,km),custom[index]);
        }
        assert_eq!(quote(&line,0.0).n(),0.0);
        assert_eq!(feedback(&line,6.000000001),[190.0,180.0]);
        assert_eq!(feedback(&line,1200.0),[220.0,210.0]);
    }
}
