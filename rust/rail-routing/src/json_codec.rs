//! Bounded UTF-8 save codec. Missing object members are omitted; array holes and
//! non-finite internal schedule sentinels become null, matching historical JSON saves.
use crate::value::Value as V;
pub(super) const MAX_BYTES:usize=64*1024*1024;
pub(super) fn parse(text:&str)->Result<V,String>{
    if text.len()>MAX_BYTES{return Err("PARSE_SIZE".into());}
    struct Parser<'a>{s:&'a [u8],at:usize,nodes:usize}
    impl Parser<'_>{
        fn ws(&mut self){while self.at<self.s.len()&&matches!(self.s[self.at],b' '|b'\r'|b'\n'|b'\t'){self.at+=1;}}
        fn take(&mut self,c:u8)->bool{if self.s.get(self.at)==Some(&c){self.at+=1;true}else{false}}
        fn hex(&mut self)->Result<u16,String>{let mut n=0;for _ in 0..4{let c=*self.s.get(self.at).ok_or("PARSE_STRING")?;self.at+=1;n=n*16+match c{b'0'..=b'9'=>(c-b'0')as u16,b'a'..=b'f'=>(c-b'a'+10)as u16,b'A'..=b'F'=>(c-b'A'+10)as u16,_=>return Err("PARSE_STRING".into())};}Ok(n)}
        fn string(&mut self)->Result<String,String>{
            if !self.take(b'"'){return Err("PARSE_STRING".into());}let mut out=String::new();let mut start=self.at;
            loop{let c=*self.s.get(self.at).ok_or("PARSE_STRING")?;if c<32{return Err("PARSE_STRING".into());}
                if c==b'"'||c==b'\\'{out.push_str(std::str::from_utf8(&self.s[start..self.at]).map_err(|_|"PARSE_UTF8")?);self.at+=1;if c==b'"'{return Ok(out);}
                    let esc=*self.s.get(self.at).ok_or("PARSE_STRING")?;self.at+=1;out.push(match esc{b'"'=>'"',b'\\'=>'\\',b'/'=>'/',b'b'=>'\x08',b'f'=>'\x0c',b'n'=>'\n',b'r'=>'\r',b't'=>'\t',b'u'=>{let hi=self.hex()?;let scalar=if (0xd800..=0xdbff).contains(&hi){if !self.take(b'\\')||!self.take(b'u'){return Err("PARSE_SURROGATE".into());}let lo=self.hex()?;if !(0xdc00..=0xdfff).contains(&lo){return Err("PARSE_SURROGATE".into());}0x10000+((hi as u32-0xd800)<<10)+(lo as u32-0xdc00)}else{hi as u32};char::from_u32(scalar).ok_or("PARSE_SURROGATE")?},_=>return Err("PARSE_STRING".into())});start=self.at;
                }else{self.at+=1;}
            }
        }
        fn value(&mut self,depth:usize)->Result<V,String>{
            self.nodes+=1;if depth>80||self.nodes>2_000_000{return Err("PARSE_STRUCTURE".into());}self.ws();
            match self.s.get(self.at).copied().ok_or("PARSE_JSON")?{
                b'"'=>Ok(V::String(self.string()?)),
                b'['=>{self.at+=1;self.ws();let mut rows=vec![];if self.take(b']'){return Ok(V::Array(rows));}loop{rows.push(self.value(depth+1)?);self.ws();if self.take(b']'){break;}if !self.take(b','){return Err("PARSE_ARRAY".into());}}Ok(V::Array(rows))},
                b'{'=>{self.at+=1;self.ws();let mut out=V::Object(vec![]);if self.take(b'}'){return Ok(out);}loop{self.ws();let key=self.string()?;if matches!(key.as_str(),"__proto__"|"prototype"|"constructor"){return Err("PARSE_KEY".into());}self.ws();if !self.take(b':'){return Err("PARSE_OBJECT".into());}let value=self.value(depth+1)?;out.set(&key,value);self.ws();if self.take(b'}'){break;}if !self.take(b','){return Err("PARSE_OBJECT".into());}}Ok(out)},
                b't'|b'f'|b'n'=>{for (word,v)in [(b"true".as_slice(),V::Bool(true)),(b"false".as_slice(),V::Bool(false)),(b"null".as_slice(),V::Null)]{if self.s[self.at..].starts_with(word){self.at+=word.len();return Ok(v);}}Err("PARSE_LITERAL".into())},
                b'-'|b'0'..=b'9'=>{let start=self.at;self.take(b'-');if !self.take(b'0'){if !matches!(self.s.get(self.at),Some(b'1'..=b'9')){return Err("PARSE_NUMBER".into());}while matches!(self.s.get(self.at),Some(b'0'..=b'9')){self.at+=1;}}
                    if self.take(b'.'){let at=self.at;while matches!(self.s.get(self.at),Some(b'0'..=b'9')){self.at+=1;}if at==self.at{return Err("PARSE_NUMBER".into());}}
                    if self.take(b'e')||self.take(b'E'){if !self.take(b'+'){self.take(b'-');}let at=self.at;while matches!(self.s.get(self.at),Some(b'0'..=b'9')){self.at+=1;}if at==self.at{return Err("PARSE_NUMBER".into());}}
                    let n=std::str::from_utf8(&self.s[start..self.at]).map_err(|_|"PARSE_NUMBER")?.parse::<f64>().map_err(|_|"PARSE_NUMBER")?;if !n.is_finite(){return Err("PARSE_NONFINITE".into());}Ok(V::Number(n))},
                _=>Err("PARSE_JSON".into())
            }
        }
    }
    let mut p=Parser{s:text.as_bytes(),at:0,nodes:0};let value=p.value(0)?;p.ws();if p.at!=p.s.len(){return Err("PARSE_TRAILING".into());}Ok(value)
}
fn string(s:&str,out:&mut String)->Result<(),String>{out.push('"');for c in s.chars(){match c{'"'=>out.push_str("\\\""),'\\'=>out.push_str("\\\\"),'\n'=>out.push_str("\\n"),'\r'=>out.push_str("\\r"),'\t'=>out.push_str("\\t"),'\x08'=>out.push_str("\\b"),'\x0c'=>out.push_str("\\f"),c if c<' '=>out.push_str(&format!("\\u{:04x}",c as u32)),_=>out.push(c)}if out.len()>MAX_BYTES{return Err("ENCODE_SIZE".into());}}out.push('"');Ok(())}
pub(super) fn encode(v:&V)->Result<String,String>{
    fn walk(v:&V,out:&mut String,depth:usize,nodes:&mut usize)->Result<(),String>{
        *nodes+=1;if depth>80||*nodes>2_000_000{return Err("ENCODE_STRUCTURE".into());}
        match v{
            V::Missing|V::Null=>out.push_str("null"),V::Bool(v)=>out.push_str(if *v{"true"}else{"false"}),
            V::Number(n)=>if !n.is_finite(){out.push_str("null")}else if *n==0.0{out.push('0')}else{out.push_str(&n.to_string())},
            V::String(s)=>string(s,out)?,V::Array(rows)=>{out.push('[');for(i,v)in rows.iter().enumerate(){if i>0{out.push(',');}walk(v,out,depth+1,nodes)?;}out.push(']');},
            V::Object(rows)=>{out.push('{');let mut first=true;for(k,v)in rows{if matches!(v,V::Missing){continue;}if matches!(k.as_str(),"__proto__"|"prototype"|"constructor"){return Err("ENCODE_KEY".into());}if !first{out.push(',');}first=false;string(k,out)?;out.push(':');walk(v,out,depth+1,nodes)?;}out.push('}');}
        }if out.len()>MAX_BYTES{return Err("ENCODE_SIZE".into());}Ok(())
    }
    let mut out=String::new();walk(v,&mut out,0,&mut 0)?;Ok(out)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn large_unicode_save_and_extensions_round_trip(){
        let mut value=crate::value::object([("extension",V::String("城市😀".repeat(1_400_000))),("negativeZero",V::Number(-0.0))]);
        value.set("holes",V::Array(vec![V::Missing,V::Number(f64::INFINITY)]));value.set("absent",V::Missing);
        let text=encode(&value).unwrap();assert!(text.len()>9*1024*1024);
        let restored=parse(&text).unwrap();assert_eq!(restored.get("extension").text(),value.get("extension").text());
        assert!(matches!(restored.get("absent"),V::Missing));assert!(matches!(restored.get("holes").array()[1],V::Null));
        assert_eq!(encode(&restored).unwrap(),text);
    }
    #[test]
    fn malformed_or_unsafe_files_are_rejected(){
        for text in ["[1,]","{\"n\":01}","1e400","{\"__proto__\":{}}","{\"x\":\"\\ud800\"}","true false"]{assert!(parse(text).is_err(),"{}",text);}
        let value=parse("{\"x\":\"\\ud83d\\ude00\",\"n\":1e-7}").unwrap();assert_eq!(value.get("x").text(),"😀");assert_eq!(value.num("n"),1e-7);
    }
}
