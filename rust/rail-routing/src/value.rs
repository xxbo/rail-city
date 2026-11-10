//! Ordered value wire for cold lifecycle transactions. Numbers retain NaN/Infinity and missing fields.
use crate::queues::Read;
#[derive(Clone, Debug)]
pub(super) enum Value {
    Missing,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}
impl Default for Value {
    fn default() -> Self {
        Self::Missing
    }
}
impl Value {
    pub fn n(&self) -> f64 {
        match self {
            Self::Number(n) => *n,
            Self::Null => 0.0,
            Self::Bool(v) => {
                if *v {
                    1.0
                } else {
                    0.0
                }
            }
            _ => f64::NAN,
        }
    }
    pub fn truth(&self) -> bool {
        match self {
            Self::Missing | Self::Null => false,
            Self::Bool(v) => *v,
            Self::Number(v) => *v != 0.0 && !v.is_nan(),
            Self::String(s) => !s.is_empty(),
            _ => true,
        }
    }
    pub fn text(&self) -> &str {
        if let Self::String(v) = self {
            v
        } else {
            ""
        }
    }
    pub fn get(&self, k: &str) -> &Value {
        if let Self::Object(v) = self {
            v.iter().find(|r| r.0 == k).map_or(&Self::Missing, |r| &r.1)
        } else {
            &Self::Missing
        }
    }
    pub fn get_mut(&mut self, k: &str) -> &mut Value {
        if !matches!(self, Self::Object(_)) {
            *self = Self::Object(vec![])
        }
        if let Self::Object(v) = self {
            let i = v.iter().position(|r| r.0 == k).unwrap_or_else(|| {
                v.push((k.to_string(), Self::Missing));
                v.len() - 1
            });
            &mut v[i].1
        } else {
            unreachable!()
        }
    }
    pub fn set(&mut self, k: &str, v: Value) {
        *self.get_mut(k) = v;
    }
    pub fn array(&self) -> &[Value] {
        if let Self::Array(v) = self {
            v
        } else {
            &[]
        }
    }
    pub fn array_mut(&mut self) -> &mut Vec<Value> {
        if !matches!(self, Self::Array(_)) {
            *self = Self::Array(vec![])
        }
        if let Self::Array(v) = self {
            v
        } else {
            unreachable!()
        }
    }
    pub fn entries(&self) -> &[(String, Value)] {
        if let Self::Object(v) = self {
            v
        } else {
            &[]
        }
    }
    pub fn entries_mut(&mut self)->&mut Vec<(String,Value)>{if !matches!(self,Self::Object(_)){*self=Self::Object(vec![]);}if let Self::Object(rows)=self{rows}else{unreachable!()}}
    pub fn num(&self, k: &str) -> f64 {
        self.get(k).n()
    }
    pub fn zero(&self, k: &str) -> f64 {
        let n = self.num(k);
        if n.is_nan() || n == 0.0 {
            0.0
        } else {
            n
        }
    }
}
pub(super) fn object(rows: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(rows.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
pub(super) fn read(r: &mut Read) -> Value {
    let n = r.u();
    let strings = (0..n)
        .map(|_| {
            let n = r.u();
            String::from_utf16_lossy(&(0..n).map(|_| r.u() as u16).collect::<Vec<_>>())
        })
        .collect::<Vec<_>>();
    fn tree(r: &mut Read, s: &[String]) -> Value {
        match r.u() {
            0 => Value::Missing,
            1 => Value::Null,
            2 => Value::Bool(false),
            3 => Value::Bool(true),
            4 => Value::Number(r.f()),
            5 => Value::String(s[r.u()].clone()),
            6 => {
                let n = r.u();
                Value::Array((0..n).map(|_| tree(r, s)).collect())
            }
            7 => {
                let n = r.u();
                Value::Object(
                    (0..n)
                        .map(|_| {
                            let k = s[r.u()].clone();
                            (k, tree(r, s))
                        })
                        .collect(),
                )
            }
            _ => panic!("invalid value tag"),
        }
    }
    tree(r, &strings)
}
fn collect(value: &Value) -> (Vec<String>, Vec<f64>) {
    let mut strings = vec![];
    let mut ids = std::collections::HashMap::<String, usize>::new();
    let mut body = vec![];
    fn intern(
        s: &str,
        strings: &mut Vec<String>,
        ids: &mut std::collections::HashMap<String, usize>,
    ) -> usize {
        if let Some(&id) = ids.get(s) {
            id
        } else {
            let id = strings.len();
            strings.push(s.into());
            ids.insert(s.into(), id);
            id
        }
    }
    fn tree(
        v: &Value,
        s: &mut Vec<String>,
        ids: &mut std::collections::HashMap<String, usize>,
        out: &mut Vec<f64>,
    ) {
        match v {
            Value::Missing => out.push(0.0),
            Value::Null => out.push(1.0),
            Value::Bool(v) => out.push(if *v { 3.0 } else { 2.0 }),
            Value::Number(v) => out.extend([4.0, *v]),
            Value::String(v) => out.extend([5.0, intern(v, s, ids) as f64]),
            Value::Array(a) => {
                out.extend([6.0, a.len() as f64]);
                for v in a {
                    tree(v, s, ids, out)
                }
            }
            Value::Object(a) => {
                out.extend([7.0, a.len() as f64]);
                for (k, v) in a {
                    out.push(intern(k, s, ids) as f64);
                    tree(v, s, ids, out)
                }
            }
        }
    }
    tree(value, &mut strings, &mut ids, &mut body);
    (strings, body)
}
pub(super) fn write(value: &Value) -> Vec<f64> {
    let (strings, body) = collect(value);
    let mut out = vec![strings.len() as f64];
    for s in strings {
        let v = s.encode_utf16().collect::<Vec<_>>();
        out.push(v.len() as f64);
        out.extend(v.iter().map(|&v| v as f64));
    }
    out.extend(body);
    out
}
pub(super) fn write_packed(value: &Value) -> (Vec<f64>, Vec<u8>) {
    let (strings, body) = collect(value);
    let mut values = vec![strings.len() as f64];
    let mut bytes = vec![];
    for s in strings {
        let at = bytes.len();
        let units = s.encode_utf16().collect::<Vec<_>>();
        values.extend([at as f64, units.len() as f64]);
        for c in units {
            bytes.extend(c.to_le_bytes());
        }
    }
    values.extend(body);
    (values, bytes)
}
pub(super) fn read_packed(v: &[f64], bytes: &[u8]) -> Option<Value> {
    fn count(v: &[f64], at: &mut usize) -> Option<usize> {
        let x = *v.get(*at)?;
        *at += 1;
        if x.is_finite() && x >= 0.0 && x.fract() == 0.0 && x <= 134217728.0 {
            Some(x as usize)
        } else {
            None
        }
    }
    fn tree(
        v: &[f64],
        at: &mut usize,
        strings: &[String],
        depth: usize,
        nodes: &mut usize,
    ) -> Option<Value> {
        if depth > 80 || *nodes >= 2_000_000 {
            return None;
        }
        *nodes += 1;
        Some(match count(v, at)? {
            0 => Value::Missing,
            1 => Value::Null,
            2 => Value::Bool(false),
            3 => Value::Bool(true),
            4 => {
                let x = *v.get(*at)?;
                *at += 1;
                Value::Number(x)
            }
            5 => Value::String(strings.get(count(v, at)?)?.clone()),
            6 => {
                let n = count(v, at)?;
                if n > 2_000_000 {
                    return None;
                }
                let mut out = vec![];
                for _ in 0..n {
                    out.push(tree(v, at, strings, depth + 1, nodes)?);
                }
                Value::Array(out)
            }
            7 => {
                let n = count(v, at)?;
                if n > 2_000_000 {
                    return None;
                }
                let mut out = vec![];
                for _ in 0..n {
                    let key = strings.get(count(v, at)?)?.clone();
                    out.push((key, tree(v, at, strings, depth + 1, nodes)?));
                }
                Value::Object(out)
            }
            _ => return None,
        })
    }
    if v.len() > 12_000_000 || bytes.len() > 134217728 {
        return None;
    }
    let mut at = 0;
    let n = count(v, &mut at)?;
    if n > v.len() / 2 {
        return None;
    }
    let mut strings = vec![];
    for _ in 0..n {
        let offset = count(v, &mut at)?;
        let len = count(v, &mut at)?;
        let end = offset.checked_add(len.checked_mul(2)?)?;
        let data = bytes.get(offset..end)?;
        let units = data
            .chunks_exact(2)
            .map(|x| u16::from_le_bytes([x[0], x[1]]))
            .collect::<Vec<_>>();
        strings.push(String::from_utf16_lossy(&units));
    }
    let result = tree(v, &mut at, &strings, 0, &mut 0)?;
    if at != v.len() {
        None
    } else {
        Some(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packed_values_preserve_wire_semantics_and_bound_strings() {
        let v = object([
            ("missing", Value::Missing),
            ("negativeZero", Value::Number(-0.0)),
            ("unicode", Value::String("\u{feff}地图😀".into())),
            ("nonfinite", Value::Number(f64::INFINITY)),
        ]);
        let (a, b) = write_packed(&v);
        let decoded = read_packed(&a, &b).unwrap();
        assert_eq!(
            write(&v).iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            write(&decoded)
                .iter()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>()
        );
        assert!(read_packed(&[1.0, 0.0, 1000.0, 1.0], &[0, 0]).is_none());
        let large = Value::String("x".repeat(9 * 1024 * 1024));
        let (a, b) = write_packed(&large);
        assert!(a.len() < 10);
        assert_eq!(b.len(), 18 * 1024 * 1024);
        assert_eq!(read_packed(&a, &b).unwrap().text().len(), 9 * 1024 * 1024);
    }
    #[test]
    fn cold_wire_preserves_missing_nonfinite_unicode_and_field_order() {
        let value = object([
            ("label", Value::String("附加字段 😀".into())),
            ("missing", Value::Missing),
            ("number", Value::Number(f64::INFINITY)),
            ("negativeZero", Value::Number(-0.0)),
        ]);
        let bytes = write(&value);
        let mut r = Read { v: &bytes, at: 0 };
        let decoded = read(&mut r);
        assert_eq!(r.at, bytes.len());
        assert_eq!(decoded.get("label").text(), "附加字段 😀");
        assert!(matches!(decoded.get("missing"), Value::Missing));
        assert!(decoded.num("number").is_infinite());
        assert!(decoded.num("negativeZero").is_sign_negative());
        assert_eq!(
            decoded
                .entries()
                .iter()
                .map(|r| r.0.as_str())
                .collect::<Vec<_>>(),
            vec!["label", "missing", "number", "negativeZero"]
        );
    }
}
