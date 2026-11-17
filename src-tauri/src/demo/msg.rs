//! Bit-level reader for Quake 3 / Quake Live network messages as stored in
//! demo files. Bytes are Huffman coded with the fixed id Software table;
//! bit counts that are not a multiple of eight are stored raw.

use super::hufftab::HUFF_CODES;
use std::sync::OnceLock;

const LOOKUP_BITS: u32 = 11;

/// Lookup from the next 11 stream bits to (symbol, code length).
fn lookup() -> &'static [(u16, u8)] {
    static TABLE: OnceLock<Vec<(u16, u8)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = vec![(0u16, 0u8); 1 << LOOKUP_BITS];
        for (sym, &(code, len)) in HUFF_CODES.iter().enumerate() {
            let step = 1usize << len;
            let mut i = code as usize;
            while i < t.len() {
                t[i] = (sym as u16, len);
                i += step;
            }
        }
        t
    })
}

pub struct Msg<'a> {
    data: &'a [u8],
    bit: usize,
    len_bits: usize,
    pub overflow: bool,
}

impl<'a> Msg<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Msg { data, bit: 0, len_bits: data.len() * 8, overflow: false }
    }

    #[inline]
    fn peek(&self) -> usize {
        let i = self.bit >> 3;
        let b = |k: usize| *self.data.get(i + k).unwrap_or(&0) as u32;
        let w = b(0) | (b(1) << 8) | (b(2) << 16);
        ((w >> (self.bit & 7)) & ((1 << LOOKUP_BITS) - 1)) as usize
    }

    pub fn read_bits(&mut self, bits: i32) -> i32 {
        if self.overflow {
            return 0;
        }
        let sgn = bits < 0;
        let mut bits = bits.unsigned_abs();
        let mut value: u32 = 0;
        let nbits = bits & 7;
        if nbits != 0 {
            if self.bit + nbits as usize > self.len_bits {
                self.overflow = true;
                return 0;
            }
            for i in 0..nbits {
                let b = (self.data[self.bit >> 3] >> (self.bit & 7)) & 1;
                value |= (b as u32) << i;
                self.bit += 1;
            }
            bits -= nbits;
        }
        if bits != 0 {
            let table = lookup();
            let mut i = 0;
            while i < bits {
                let (sym, len) = table[self.peek()];
                self.bit += len as usize;
                if self.bit > self.len_bits || len == 0 {
                    self.overflow = true;
                    return 0;
                }
                value |= (sym as u32) << (i + nbits);
                i += 8;
            }
        }
        // Mirrors the engine: sign extension only applies to whole-byte widths.
        if sgn && bits > 0 && bits < 32 && value & (1 << (bits - 1)) != 0 {
            value |= !((1u32 << bits) - 1);
        }
        value as i32
    }

    pub fn read_byte(&mut self) -> i32 {
        let v = self.read_bits(8);
        if self.overflow { -1 } else { v & 0xff }
    }

    pub fn read_short(&mut self) -> i32 {
        let v = self.read_bits(16) as i16 as i32;
        if self.overflow { -1 } else { v }
    }

    pub fn read_long(&mut self) -> i32 {
        let v = self.read_bits(32);
        if self.overflow { -1 } else { v }
    }

    fn read_string_limit(&mut self, limit: usize, high_ascii: bool) -> String {
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = self.read_byte();
            if c <= 0 {
                break;
            }
            let mut c = c as u8;
            if c == b'%' || (!high_ascii && c > 127) {
                c = b'.';
            }
            if out.len() < limit - 1 {
                out.push(c);
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// `high_ascii` is true for protocol 91+, which transmits UTF-8.
    pub fn read_string(&mut self, high_ascii: bool) -> String {
        self.read_string_limit(1024, high_ascii)
    }

    pub fn read_big_string(&mut self, high_ascii: bool) -> String {
        self.read_string_limit(8192, high_ascii)
    }

    pub fn skip_bytes(&mut self, n: usize) {
        for _ in 0..n {
            self.read_byte();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huffman_table_is_a_complete_prefix_code() {
        // Kraft sum of a full binary tree is exactly 1.
        let sum: f64 = HUFF_CODES.iter().map(|&(_, l)| 0.5f64.powi(l as i32)).sum();
        assert!((sum - 1.0).abs() < 1e-12);
        assert!(lookup().iter().all(|&(_, l)| l > 0));
    }
}
