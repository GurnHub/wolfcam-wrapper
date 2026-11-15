//! Quake 3 / Quake Live demo decoding.

mod fields;
mod hufftab;
mod msg;
pub mod parser;

pub use parser::{parse_file, DemoInfo, Kill};
