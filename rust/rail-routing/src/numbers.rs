//! Lightweight hashing for bounded internal numeric IDs; iteration order is never semantic.
use std::hash::{BuildHasherDefault, Hasher};
#[derive(Default)]
pub struct NumericHasher(u32);
impl NumericHasher {
    fn mix(&mut self, x: u32) {
        self.0 = self
            .0
            .rotate_left(5)
            .wrapping_add(x)
            .wrapping_mul(0x9e3779b9);
    }
}
impl Hasher for NumericHasher {
    fn finish(&self) -> u64 {
        (self.0 as u64).wrapping_mul(0x9e3779b97f4a7c15)
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.mix(b as u32);
        }
    }
    fn write_usize(&mut self, x: usize) {
        self.mix(x as u32);
    }
    fn write_u64(&mut self, x: u64) {
        self.mix(x as u32);
        self.mix((x >> 32) as u32);
    }
    fn write_i64(&mut self, x: i64) {
        self.write_u64(x as u64);
    }
    fn write_u32(&mut self, x: u32) {
        self.mix(x);
    }
    fn write_i32(&mut self, x: i32) {
        self.mix(x as u32);
    }
    fn write_u8(&mut self, x: u8) {
        self.mix(x as u32);
    }
}
pub type Map<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<NumericHasher>>;
pub type Set<K> = std::collections::HashSet<K, BuildHasherDefault<NumericHasher>>;

// Sparse integer directories grow in small allocations. This keeps cold metadata
// and realized journeys from reallocating one large contiguous WASM hash table.
struct Page<T> { rows: [Option<T>; 256], used: usize }
pub(super) struct Paged<T> { pages: Map<usize, Box<Page<T>>>, len: usize }
impl<T> Default for Paged<T> {
    fn default() -> Self { Self { pages: Map::default(), len: 0 } }
}
impl<T> Paged<T> {
    pub fn len(&self) -> usize { self.len }
    pub fn retain(&mut self,mut keep:impl FnMut(usize,&mut T)->bool){
        let mut empty=vec![];for(&base,page)in &mut self.pages{for(slot,row)in page.rows.iter_mut().enumerate(){if row.as_mut().is_some_and(|value|!keep(base*256+slot,value)){*row=None;page.used-=1;self.len-=1;}}if page.used==0{empty.push(base);}}
        for base in empty{self.pages.remove(&base);}
    }
    pub fn get(&self, index: &usize) -> Option<&T> { self.pages.get(&(index / 256))?.rows[index % 256].as_ref() }
    pub fn get_mut(&mut self, index: &usize) -> Option<&mut T> { self.pages.get_mut(&(index / 256))?.rows[index % 256].as_mut() }
    pub fn insert(&mut self, index: usize, value: T) -> Option<T> {
        let page = self.pages.entry(index / 256).or_insert_with(|| Box::new(Page { rows: std::array::from_fn(|_| None), used: 0 }));
        let previous = page.rows[index % 256].replace(value);
        if previous.is_none() { page.used += 1; self.len += 1; }
        previous
    }
    pub fn remove(&mut self, index: &usize) -> Option<T> {
        let page = self.pages.get_mut(&(index / 256))?;
        let previous = page.rows[index % 256].take();
        if previous.is_some() { page.used -= 1; self.len -= 1; }
        if page.used == 0 { self.pages.remove(&(index / 256)); }
        previous
    }
}
impl<T> std::ops::Index<&usize> for Paged<T> {
    type Output = T;
    fn index(&self, index: &usize) -> &T { self.get(index).expect("directory entry missing") }
}
#[cfg(test)] mod paged_tests {
    #[test] fn sparse_pages_preserve_replacements_and_release_empty_allocations() {
        let mut values=super::Paged::default();
        for index in [0,255,256,99999] { assert_eq!(values.insert(index,index+1),None); }
        assert_eq!(values.len(),4);assert_eq!(values.pages.len(),3);
        assert_eq!(values.insert(256,7),Some(257));assert_eq!(values.len(),4);
        *values.get_mut(&99999).unwrap()=8;assert_eq!(values[&99999],8);
        assert_eq!(values.remove(&256),Some(7));assert_eq!(values.pages.len(),2);
        assert_eq!(values.remove(&256),None);assert!(values.get(&257).is_none());
        for index in [0,255,99999] { values.remove(&index); }
        assert_eq!(values.len(),0);assert!(values.pages.is_empty());
    }
}
