//! Demo library: folder scanning with a parse cache, and the frag finder.

use crate::demo::parser::{is_demo_file, parse_file, DemoInfo, Kill};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Bump when `DemoInfo` or the parser changes in a way that invalidates cached results.
const CACHE_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DemoEntry {
    pub path: String,
    pub file_name: String,
    pub dir: String,
    pub size: u64,
    /// Modification time, seconds since the Unix epoch.
    pub modified: u64,
    pub protocol: i32,
    pub map: String,
    pub gametype_name: String,
    pub hostname: String,
    pub timestamp: Option<i64>,
    pub pov_name: String,
    /// Names of everyone who was on a playing team at some point.
    pub players: Vec<String>,
    pub duration_ms: i32,
    pub kill_count: u32,
    pub pov_kills: u32,
    pub error: Option<String>,
    pub warning: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    version: u32,
    demos: HashMap<String, DemoEntry>,
}

fn file_stamp(path: &Path) -> (u64, u64) {
    let md = std::fs::metadata(path).ok();
    let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = md
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (size, modified)
}

fn hash_path(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn info_cache_file(cache_dir: &Path, path: &str) -> PathBuf {
    cache_dir.join("demos").join(format!("{}.json", hash_path(path)))
}

fn entry_from(path: &Path, size: u64, modified: u64, parsed: &Result<DemoInfo, String>) -> DemoEntry {
    let mut e = DemoEntry {
        path: path.to_string_lossy().into_owned(),
        file_name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        dir: path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        size,
        modified,
        ..Default::default()
    };
    match parsed {
        Ok(i) => {
            e.protocol = i.protocol;
            e.map = i.map.clone();
            e.gametype_name = i.gametype_name.clone();
            e.hostname = i.hostname.clone();
            e.timestamp = i.timestamp;
            e.pov_name = i.pov_name.clone();
            let mut names: Vec<String> = i.players.iter().filter(|p| p.team != 3).map(|p| p.name.clone()).collect();
            names.dedup();
            e.players = names;
            e.duration_ms = i.duration_ms;
            e.kill_count = i.kills.len() as u32;
            e.pov_kills = i.kills.iter().filter(|k| k.killer == i.pov_client && !k.own_goal).count() as u32;
            e.warning = i.warning.clone();
        }
        Err(err) => e.error = Some(err.clone()),
    }
    e
}

fn load_index(cache_dir: &Path) -> Index {
    std::fs::read(cache_dir.join("library.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Index>(&b).ok())
        .filter(|i| i.version == CACHE_VERSION)
        .unwrap_or_default()
}

fn parse_and_cache(cache_dir: &Path, path: &Path) -> (DemoEntry, Result<DemoInfo, String>) {
    let (size, modified) = file_stamp(path);
    let parsed = parse_file(path);
    let entry = entry_from(path, size, modified, &parsed);
    if let Ok(info) = &parsed {
        let f = info_cache_file(cache_dir, &entry.path);
        if let Some(parent) = f.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec(&(size, modified, CACHE_VERSION, info)) {
            let _ = std::fs::write(f, json);
        }
    }
    (entry, parsed)
}

/// Scans the given folders (recursively) and returns one entry per demo.
/// Unchanged files are served from the cache unless `force` is set.
pub fn scan(cache_dir: &Path, dirs: &[String], force: bool, progress: impl Fn(usize, usize) + Sync) -> Vec<DemoEntry> {
    let mut files: Vec<PathBuf> = Vec::new();
    for d in dirs {
        for e in walkdir::WalkDir::new(d).follow_links(true).into_iter().flatten() {
            if e.file_type().is_file() && is_demo_file(e.path()) {
                files.push(e.into_path());
            }
        }
    }
    files.sort();
    files.dedup();
    let index = if force { Index::default() } else { load_index(cache_dir) };
    let total = files.len();
    let done = AtomicUsize::new(0);
    let mut entries: Vec<DemoEntry> = files
        .par_iter()
        .map(|path| {
            let key = path.to_string_lossy();
            let (size, modified) = file_stamp(path);
            let entry = match index.demos.get(key.as_ref()) {
                Some(c) if c.size == size && c.modified == modified => c.clone(),
                _ => parse_and_cache(cache_dir, path).0,
            };
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 8 == 0 || n == total {
                progress(n, total);
            }
            entry
        })
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let new_index = Index { version: CACHE_VERSION, demos: entries.iter().map(|e| (e.path.clone(), e.clone())).collect() };
    let _ = std::fs::create_dir_all(cache_dir);
    if let Ok(json) = serde_json::to_vec(&new_index) {
        let _ = std::fs::write(cache_dir.join("library.json"), json);
    }
    entries
}

/// Full parse result for one demo, from cache when the file is unchanged.
pub fn get_demo(cache_dir: &Path, path: &str) -> Result<DemoInfo, String> {
    let p = Path::new(path);
    let (size, modified) = file_stamp(p);
    if let Ok(bytes) = std::fs::read(info_cache_file(cache_dir, path)) {
        if let Ok((s, m, v, info)) = serde_json::from_slice::<(u64, u64, u32, DemoInfo)>(&bytes) {
            if s == size && m == modified && v == CACHE_VERSION {
                return Ok(info);
            }
        }
    }
    parse_and_cache(cache_dir, p).1
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct FragFilter {
    /// Killer name must contain one of these (case-insensitive). Empty: anyone.
    pub players: Vec<String>,
    /// Only kills made by the player who recorded the demo.
    pub pov_only: bool,
    /// Weapon labels as produced by the parser ("RL", "RG", ...). Empty: any.
    pub weapons: Vec<String>,
    pub victim: String,
    /// Minimum number of kills in a sequence (1 lists every kill).
    pub min_kills: u32,
    /// Longest allowed gap between two kills of the same sequence.
    pub window_ms: i32,
    pub include_warmup: bool,
    pub include_own_goals: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Frag {
    pub path: String,
    pub file_name: String,
    pub map: String,
    pub gametype_name: String,
    pub killer: String,
    pub killer_client: i32,
    pub start_time: i32,
    pub end_time: i32,
    pub clock_ms: i32,
    pub warmup: bool,
    pub kills: Vec<Kill>,
}

pub fn find_frags(info: &DemoInfo, path: &str, filter: &FragFilter) -> Vec<Frag> {
    let wanted_players: Vec<String> = filter.players.iter().map(|p| p.to_lowercase()).filter(|p| !p.is_empty()).collect();
    let victim = filter.victim.to_lowercase();
    let min = filter.min_kills.max(1) as usize;
    let file_name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut by_killer: HashMap<i32, Vec<&Kill>> = HashMap::new();
    for k in &info.kills {
        if k.own_goal && !filter.include_own_goals {
            continue;
        }
        if k.warmup && !filter.include_warmup {
            continue;
        }
        if filter.pov_only && k.killer != info.pov_client {
            continue;
        }
        if !filter.weapons.is_empty() && !filter.weapons.iter().any(|w| w.eq_ignore_ascii_case(&k.weapon)) {
            continue;
        }
        let killer = k.killer_name.to_lowercase();
        if !wanted_players.is_empty() && !wanted_players.iter().any(|p| killer.contains(p)) {
            continue;
        }
        if !victim.is_empty() && !k.victim_name.to_lowercase().contains(&victim) {
            continue;
        }
        by_killer.entry(k.killer).or_default().push(k);
    }
    let mut out = Vec::new();
    for (client, kills) in by_killer {
        let mut seq: Vec<&Kill> = Vec::new();
        let mut flush = |seq: &mut Vec<&Kill>| {
            if seq.len() >= min {
                out.push(Frag {
                    path: path.to_string(),
                    file_name: file_name.clone(),
                    map: info.map.clone(),
                    gametype_name: info.gametype_name.clone(),
                    killer: seq[0].killer_name.clone(),
                    killer_client: client,
                    start_time: seq[0].server_time,
                    end_time: seq[seq.len() - 1].server_time,
                    clock_ms: seq[0].clock_ms,
                    warmup: seq[0].warmup,
                    kills: seq.iter().map(|k| (*k).clone()).collect(),
                });
            }
            seq.clear();
        };
        for k in kills {
            let same_player = seq.last().map(|l| l.killer_name == k.killer_name).unwrap_or(true);
            let close = seq.last().map(|l| k.server_time - l.server_time <= filter.window_ms).unwrap_or(true);
            if !(same_player && close) {
                flush(&mut seq);
            }
            seq.push(k);
        }
        flush(&mut seq);
    }
    out.sort_by_key(|f| f.start_time);
    out
}

pub fn search_frags(cache_dir: &Path, paths: &[String], filter: &FragFilter) -> Vec<Frag> {
    let mut all: Vec<Frag> = paths
        .par_iter()
        .flat_map(|p| match get_demo(cache_dir, p) {
            Ok(info) => find_frags(&info, p, filter),
            Err(_) => Vec::new(),
        })
        .collect();
    all.sort_by(|a, b| b.kills.len().cmp(&a.kills.len()).then(a.path.cmp(&b.path)).then(a.start_time.cmp(&b.start_time)));
    all.truncate(5000);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kill(t: i32, killer: i32, name: &str, weapon: &str) -> Kill {
        Kill {
            server_time: t,
            clock_ms: t,
            warmup: false,
            killer,
            victim: 9,
            killer_name: name.into(),
            victim_name: "victim".into(),
            killer_team: 0,
            victim_team: 0,
            mod_id: 0,
            weapon: weapon.into(),
            own_goal: false,
        }
    }

    fn demo() -> DemoInfo {
        DemoInfo {
            pov_client: 1,
            kills: vec![
                kill(1000, 1, "alpha", "RL"),
                kill(2500, 1, "alpha", "RG"),
                kill(3000, 2, "bravo", "RG"),
                kill(4000, 1, "alpha", "RL"),
                kill(30000, 1, "alpha", "LG"),
                Kill { own_goal: true, ..kill(31000, 1, "alpha", "RL") },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn groups_kills_into_sequences() {
        let f = FragFilter { min_kills: 3, window_ms: 3000, ..Default::default() };
        let r = find_frags(&demo(), "/d/a.dm_91", &f);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kills.len(), 3);
        assert_eq!((r[0].start_time, r[0].end_time, r[0].killer.as_str()), (1000, 4000, "alpha"));
        assert_eq!(r[0].file_name, "a.dm_91");
    }

    #[test]
    fn filters_by_weapon_player_and_own_goals() {
        let d = demo();
        let rg = FragFilter { min_kills: 1, window_ms: 0, weapons: vec!["rg".into()], ..Default::default() };
        assert_eq!(find_frags(&d, "x", &rg).len(), 2);
        let bravo = FragFilter { min_kills: 1, window_ms: 0, players: vec!["BRAV".into()], ..Default::default() };
        assert_eq!(find_frags(&d, "x", &bravo).len(), 1);
        let pov = FragFilter { min_kills: 1, window_ms: 0, pov_only: true, ..Default::default() };
        assert_eq!(find_frags(&d, "x", &pov).len(), 4);
        let own = FragFilter { include_own_goals: true, ..pov };
        assert_eq!(find_frags(&d, "x", &own).len(), 5);
    }

    #[test]
    fn path_hash_is_stable() {
        assert_eq!(hash_path("abc"), hash_path("abc"));
        assert_ne!(hash_path("abc"), hash_path("abd"));
    }
}
