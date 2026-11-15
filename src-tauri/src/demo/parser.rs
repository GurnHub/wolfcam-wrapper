//! Demo file parser for Quake 3 (dm_66..dm_71) and Quake Live (dm_73,
//! dm_90, dm_91) demos. It walks every message, tracks config strings and
//! snapshots, and extracts what the UI needs: match metadata, the player
//! list, obituaries (kills) and chat.
//!
//! The decoding rules follow the WolfcamQL client so that the times reported
//! here line up with what `seekservertime` and `at` expect.

use super::fields::*;
use super::msg::Msg;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MAX_GENTITIES: usize = 1024;
const ENTITYNUM_NONE: i32 = 1023;
const ENTITYNUM_WORLD: i32 = 1022;
const GENTITYNUM_BITS: i32 = 10;
const MAX_FIELDS: usize = 64;
const PACKET_BACKUP: usize = 32;
const FLOAT_INT_BITS: i32 = 13;
const FLOAT_INT_BIAS: i32 = 4096;
const ET_EVENTS: i32 = 13;
const EV_EVENT_BITS: i32 = 0x300;
const EF_TELEPORT_BIT: i32 = 0x4;
const EF_PLAYER_EVENT: i32 = 0x10;
const EVENT_VALID_MSEC: i32 = 300;
const MAX_CLIENTS: usize = 64;

const SVC_NOP: i32 = 1;
const SVC_GAMESTATE: i32 = 2;
const SVC_CONFIGSTRING: i32 = 3;
const SVC_BASELINE: i32 = 4;
const SVC_SERVERCOMMAND: i32 = 5;
const SVC_SNAPSHOT: i32 = 7;
const SVC_EOF: i32 = 8;

type Fields = [i32; MAX_FIELDS];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerInfo {
    pub client_num: i32,
    /// Name with colour codes removed.
    pub name: String,
    /// Name as sent by the server, including `^n` colour codes.
    pub raw_name: String,
    /// 0 free, 1 red, 2 blue, 3 spectator.
    pub team: i32,
    pub clan: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Kill {
    pub server_time: i32,
    /// Milliseconds on the game clock (rising), or since warmup began.
    pub clock_ms: i32,
    pub warmup: bool,
    pub killer: i32,
    pub victim: i32,
    pub killer_name: String,
    pub victim_name: String,
    pub killer_team: i32,
    pub victim_team: i32,
    pub mod_id: i32,
    /// Short weapon label, e.g. "RL", "RG", "LG".
    pub weapon: String,
    /// True for suicides, world deaths and team kills.
    pub own_goal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub server_time: i32,
    pub clock_ms: i32,
    pub team: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DemoInfo {
    pub protocol: i32,
    pub map: String,
    pub gametype: i32,
    pub gametype_name: String,
    pub hostname: String,
    /// Unix time the level started, when the server provides it (Quake Live).
    pub timestamp: Option<i64>,
    pub pov_client: i32,
    pub pov_name: String,
    pub players: Vec<PlayerInfo>,
    pub first_server_time: i32,
    pub last_server_time: i32,
    pub duration_ms: i32,
    pub game_start_time: Option<i32>,
    pub game_end_time: Option<i32>,
    pub has_warmup: bool,
    pub snapshots: u32,
    pub kills: Vec<Kill>,
    pub chats: Vec<Chat>,
    /// Set when the file ended early or a message could not be decoded.
    pub warning: Option<String>,
}

#[derive(Clone)]
struct Snapshot {
    valid: bool,
    message_num: i32,
    server_time: i32,
    ps: Fields,
    entities: Vec<(u16, Fields)>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Snapshot { valid: false, message_num: -1, server_time: 0, ps: [0; MAX_FIELDS], entities: Vec::new() }
    }
}

struct Layout {
    es: &'static [(&'static str, i8)],
    ps: &'static [(&'static str, i8)],
    ev_obituary: i32,
    cs_players: usize,
    cs_level_start: usize,
    cs_warmup: usize,
    cs_intermission: usize,
    // entity field indices
    e_type: usize,
    e_event: usize,
    e_event_parm: usize,
    e_other: usize,
    e_other2: usize,
    e_flags: usize,
}

fn idx(table: &[(&str, i8)], name: &str) -> usize {
    table.iter().position(|f| f.0 == name).expect("known field")
}

impl Layout {
    fn for_protocol(p: i32) -> Option<Layout> {
        let (es, ps, ql): (&'static [(&str, i8)], &'static [(&str, i8)], bool) = match p {
            66..=71 => (ES_Q3, PS_Q3, false),
            73 => (ES_QL73, PS_Q3, true),
            90 => (ES_QL90, PS_QL90, true),
            91 => (ES_QL91, PS_QL91, true),
            _ => return None,
        };
        Some(Layout {
            es,
            ps,
            ev_obituary: if ql { 58 } else { 60 },
            cs_players: if ql { 529 } else { 544 },
            cs_level_start: if ql { 13 } else { 21 },
            cs_warmup: 5,
            cs_intermission: if ql { 14 } else { 22 },
            e_type: idx(es, "eType"),
            e_event: idx(es, "event"),
            e_event_parm: idx(es, "eventParm"),
            e_other: idx(es, "otherEntityNum"),
            e_other2: idx(es, "otherEntityNum2"),
            e_flags: idx(es, "eFlags"),
        })
    }
}

struct Obit {
    number: i32,
    first_server_time: i32,
    last_message_num: i32,
}

struct Parser {
    protocol: i32,
    layout: Option<Layout>,
    configstrings: HashMap<usize, String>,
    baselines: Vec<Fields>,
    snapshots: Vec<Snapshot>,
    last_snap: Option<usize>,
    client_num: i32,
    last_command_seq: i32,
    big_cs: String,
    ent_prev_event: Vec<i32>,
    ent_snap_time: Vec<i32>,
    obits: Vec<Obit>,
    warmup_start: Option<i32>,
    seen_players: Vec<PlayerInfo>,
    info: DemoInfo,
}

pub fn strip_colors(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^' {
            if let Some(n) = chars.peek() {
                if *n != '^' {
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

pub fn info_value<'a>(info: &'a str, key: &str) -> Option<&'a str> {
    let mut parts = info.split('\\');
    if info.starts_with('\\') {
        parts.next();
    }
    loop {
        let k = parts.next()?;
        let v = parts.next()?;
        if k.eq_ignore_ascii_case(key) {
            return Some(v);
        }
    }
}

/// Splits a server command the way the engine tokenizer does.
fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i] <= b' ' {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        if b[i] == b'"' {
            let start = i + 1;
            i = start;
            while i < b.len() && b[i] != b'"' {
                i += 1;
            }
            out.push(String::from_utf8_lossy(&b[start..i]).into_owned());
            i += 1;
        } else {
            let start = i;
            while i < b.len() && b[i] > b' ' {
                i += 1;
            }
            out.push(String::from_utf8_lossy(&b[start..i]).into_owned());
        }
    }
    out
}

pub fn gametype_name(protocol: i32, gt: i32) -> &'static str {
    if protocol >= 73 {
        match gt {
            0 => "FFA",
            1 => "Duel",
            2 => "Race",
            3 => "TDM",
            4 => "CA",
            5 => "CTF",
            6 => "1FCTF",
            7 => "Obelisk",
            8 => "Harvester",
            9 => "Freeze Tag",
            10 => "Domination",
            11 => "Attack & Defend",
            12 => "Red Rover",
            _ => "Unknown",
        }
    } else {
        match gt {
            0 => "FFA",
            1 => "Duel",
            2 => "Single Player",
            3 => "TDM",
            4 => "CTF",
            5 => "1FCTF",
            6 => "Obelisk",
            7 => "Harvester",
            _ => "Unknown",
        }
    }
}

pub fn weapon_label(mod_id: i32) -> &'static str {
    match mod_id {
        1 => "SG",
        2 => "Gauntlet",
        3 => "MG",
        4 | 5 => "GL",
        6 | 7 => "RL",
        8 | 9 => "PG",
        10 | 33 => "RG",
        11 | 31 => "LG",
        12 | 13 => "BFG",
        14 => "Water",
        15 => "Slime",
        16 => "Lava",
        17 => "Crush",
        18 => "Telefrag",
        19 => "Fall",
        20 => "Suicide",
        21 => "Laser",
        22 => "Trigger",
        23 => "Nailgun",
        24 => "Chaingun",
        25 => "Prox Mine",
        26 => "Kamikaze",
        27 => "Juiced",
        28 => "Grapple",
        29 => "Team Switch",
        30 => "Thaw",
        32 => "HMG",
        _ => "Unknown",
    }
}

impl Parser {
    fn new(ext_protocol: i32) -> Self {
        Parser {
            protocol: ext_protocol,
            layout: None,
            configstrings: HashMap::new(),
            baselines: vec![[0; MAX_FIELDS]; MAX_GENTITIES],
            snapshots: vec![Snapshot::default(); PACKET_BACKUP],
            last_snap: None,
            client_num: 0,
            last_command_seq: 0,
            big_cs: String::new(),
            ent_prev_event: vec![0; MAX_GENTITIES],
            ent_snap_time: vec![0; MAX_GENTITIES],
            obits: Vec::new(),
            warmup_start: None,
            seen_players: Vec::new(),
            info: DemoInfo::default(),
        }
    }

    fn high_ascii(&self) -> bool {
        self.protocol >= 91
    }

    fn cs(&self, i: usize) -> &str {
        self.configstrings.get(&i).map(|s| s.as_str()).unwrap_or("")
    }

    fn cs_int(&self, i: usize) -> i32 {
        self.cs(i).trim().parse().unwrap_or(0)
    }

    fn current_time(&self) -> i32 {
        self.last_snap.map(|i| self.snapshots[i].server_time).unwrap_or(0)
    }

    fn in_warmup(&self) -> bool {
        match &self.layout {
            Some(l) => self.cs_int(l.cs_warmup) != 0,
            None => false,
        }
    }

    fn clock_ms(&self, server_time: i32) -> i32 {
        let Some(l) = &self.layout else { return 0 };
        if self.in_warmup() {
            server_time - self.warmup_start.unwrap_or(self.info.first_server_time)
        } else {
            let start = self.cs_int(l.cs_level_start);
            if start > 0 { (server_time - start).max(0) } else { server_time - self.info.first_server_time }
        }
    }

    fn player(&self, client: i32) -> Option<PlayerInfo> {
        let l = self.layout.as_ref()?;
        if !(0..MAX_CLIENTS as i32).contains(&client) {
            return None;
        }
        let s = self.cs(l.cs_players + client as usize);
        if s.is_empty() {
            return None;
        }
        let raw = info_value(s, "n").unwrap_or("").to_string();
        Some(PlayerInfo {
            client_num: client,
            name: strip_colors(&raw),
            raw_name: raw,
            team: info_value(s, "t").and_then(|t| t.parse().ok()).unwrap_or(0),
            clan: strip_colors(info_value(s, "cn").unwrap_or("")),
        })
    }

    fn set_configstring(&mut self, i: usize, value: String) {
        if i == 0 {
            if let Some(p) = info_value(&value, "protocol").and_then(|p| p.parse::<i32>().ok()) {
                self.protocol = p;
            }
            if self.layout.is_none() {
                self.layout = Layout::for_protocol(self.protocol);
            }
        }
        let server_time = self.current_time();
        let (is_player, is_warmup, is_intermission, is_level_start) = match &self.layout {
            Some(l) => (
                (l.cs_players..l.cs_players + MAX_CLIENTS).contains(&i),
                i == l.cs_warmup,
                i == l.cs_intermission,
                i == l.cs_level_start,
            ),
            None => (false, false, false, false),
        };
        let was_warmup = self.in_warmup();
        self.configstrings.insert(i, value);
        if is_player {
            let client = (i - self.layout.as_ref().unwrap().cs_players) as i32;
            if let Some(p) = self.player(client) {
                if !p.name.is_empty() && !self.seen_players.iter().any(|q| q.client_num == p.client_num && q.name == p.name) {
                    self.seen_players.push(p);
                } else if let Some(q) = self.seen_players.iter_mut().rev().find(|q| q.client_num == p.client_num && q.name == p.name) {
                    // Keep the most recent playing team rather than a later switch to spectator.
                    if p.team != 3 {
                        q.team = p.team;
                    }
                }
            }
        }
        if is_warmup {
            let now_warmup = self.in_warmup();
            if now_warmup {
                self.info.has_warmup = true;
                if self.warmup_start.is_none() {
                    self.warmup_start = Some(if server_time != 0 { server_time } else { self.info.first_server_time });
                }
            } else if was_warmup && self.last_snap.is_some() {
                self.info.game_start_time = None; // set again from the level start time below
            }
        }
        if (is_level_start || is_warmup) && !self.in_warmup() {
            let l = self.layout.as_ref().unwrap();
            let start = self.cs_int(l.cs_level_start);
            if start > 0 && self.info.game_end_time.is_none() {
                self.info.game_start_time = Some(start);
            }
        }
        if is_intermission && self.cs_int(i) != 0 && self.info.game_end_time.is_none() && self.last_snap.is_some() {
            self.info.game_end_time = Some(server_time);
        }
    }

    fn read_delta_entity(&self, msg: &mut Msg, from: &Fields, number: i32) -> Option<Fields> {
        let l = self.layout.as_ref().unwrap();
        let _ = number;
        if msg.read_bits(1) == 1 {
            return None; // removed
        }
        if msg.read_bits(1) == 0 {
            return Some(*from);
        }
        let lc = msg.read_byte();
        if lc < 0 || lc as usize > l.es.len() {
            msg.overflow = true;
            return Some(*from);
        }
        let mut to = *from;
        for (i, field) in l.es.iter().enumerate().take(lc as usize) {
            if msg.read_bits(1) == 0 {
                continue;
            }
            if field.1 == 0 {
                if msg.read_bits(1) == 0 {
                    to[i] = 0;
                } else if msg.read_bits(1) == 0 {
                    let t = msg.read_bits(FLOAT_INT_BITS) - FLOAT_INT_BIAS;
                    to[i] = (t as f32).to_bits() as i32;
                } else {
                    to[i] = msg.read_bits(32);
                }
            } else if msg.read_bits(1) == 0 {
                to[i] = 0;
            } else {
                to[i] = msg.read_bits(field.1 as i32);
            }
        }
        Some(to)
    }

    fn read_delta_playerstate(&self, msg: &mut Msg, from: &Fields) -> Fields {
        let l = self.layout.as_ref().unwrap();
        let mut to = *from;
        let lc = msg.read_byte();
        if lc < 0 || lc as usize > l.ps.len() {
            msg.overflow = true;
            return to;
        }
        for (i, field) in l.ps.iter().enumerate().take(lc as usize) {
            if msg.read_bits(1) == 0 {
                continue;
            }
            if field.1 == 0 {
                if msg.read_bits(1) == 0 {
                    let t = msg.read_bits(FLOAT_INT_BITS) - FLOAT_INT_BIAS;
                    to[i] = (t as f32).to_bits() as i32;
                } else {
                    to[i] = msg.read_bits(32);
                }
            } else {
                to[i] = msg.read_bits(field.1 as i32);
            }
        }
        if msg.read_bits(1) != 0 {
            // stats, persistant, ammo: shorts; powerups: longs. Values are not needed here.
            for longs in [false, false, false, true] {
                if msg.read_bits(1) != 0 {
                    let bits = msg.read_bits(16);
                    for i in 0..16 {
                        if bits & (1 << i) != 0 {
                            if longs {
                                msg.read_long();
                            } else {
                                msg.read_short();
                            }
                        }
                    }
                }
            }
        }
        to
    }

    fn parse_gamestate(&mut self, msg: &mut Msg) -> Result<(), String> {
        self.configstrings.clear();
        self.baselines.iter_mut().for_each(|b| *b = [0; MAX_FIELDS]);
        self.snapshots.iter_mut().for_each(|s| s.valid = false);
        self.last_command_seq = msg.read_long();
        loop {
            let cmd = msg.read_byte();
            if cmd == SVC_EOF || msg.overflow {
                break;
            }
            match cmd {
                SVC_CONFIGSTRING => {
                    let i = msg.read_short();
                    if !(0..1024).contains(&i) {
                        return Err(format!("bad configstring index {i}"));
                    }
                    let s = msg.read_big_string(self.high_ascii());
                    self.set_configstring(i as usize, s);
                }
                SVC_BASELINE => {
                    if self.layout.is_none() {
                        return Err(format!("unsupported demo protocol {}", self.protocol));
                    }
                    let n = msg.read_bits(GENTITYNUM_BITS);
                    if !(0..MAX_GENTITIES as i32).contains(&n) {
                        return Err(format!("bad baseline entity {n}"));
                    }
                    let zero = [0; MAX_FIELDS];
                    if let Some(e) = self.read_delta_entity(msg, &zero, n) {
                        self.baselines[n as usize] = e;
                    }
                }
                _ => return Err(format!("bad command {cmd} in gamestate")),
            }
        }
        self.client_num = msg.read_long();
        msg.read_long(); // checksum feed
        if self.layout.is_none() {
            return Err(format!("unsupported demo protocol {}", self.protocol));
        }
        Ok(())
    }

    fn parse_snapshot(&mut self, msg: &mut Msg, message_num: i32) -> Result<(), String> {
        if self.layout.is_none() {
            return Err("snapshot before gamestate".into());
        }
        let server_time = msg.read_long();
        let delta_num = msg.read_byte();
        let _snap_flags = msg.read_byte();
        let mut valid;
        let old: Option<usize> = if delta_num == 0 {
            valid = true;
            None
        } else {
            let from = message_num - delta_num;
            let i = (from as usize) & (PACKET_BACKUP - 1);
            let o = &self.snapshots[i];
            valid = o.valid && o.message_num == from;
            Some(i)
        };
        let area_len = msg.read_byte();
        if !(0..=32).contains(&area_len) {
            return Err(format!("bad areamask size {area_len}"));
        }
        msg.skip_bytes(area_len as usize);

        let zero = [0; MAX_FIELDS];
        let ps = self.read_delta_playerstate(msg, old.map(|i| &self.snapshots[i].ps).unwrap_or(&zero));

        // Packet entities: merge the delta list with the entities of the source frame.
        let empty: Vec<(u16, Fields)> = Vec::new();
        let old_entities = old.map(|i| &self.snapshots[i].entities).unwrap_or(&empty);
        let mut entities: Vec<(u16, Fields)> = Vec::with_capacity(old_entities.len() + 8);
        let mut oi = 0;
        loop {
            let newnum = msg.read_bits(GENTITYNUM_BITS);
            if msg.overflow {
                return Err("snapshot ended early".into());
            }
            if newnum == ENTITYNUM_NONE {
                break;
            }
            while oi < old_entities.len() && (old_entities[oi].0 as i32) < newnum {
                entities.push(old_entities[oi]);
                oi += 1;
            }
            if oi < old_entities.len() && old_entities[oi].0 as i32 == newnum {
                if let Some(e) = self.read_delta_entity(msg, &old_entities[oi].1, newnum) {
                    entities.push((newnum as u16, e));
                }
                oi += 1;
            } else if let Some(e) = self.read_delta_entity(msg, &self.baselines[newnum as usize], newnum) {
                entities.push((newnum as u16, e));
            }
        }
        entities.extend_from_slice(&old_entities[oi..]);
        if msg.overflow {
            valid = false;
        }

        let slot = (message_num as usize) & (PACKET_BACKUP - 1);
        self.snapshots[slot] = Snapshot { valid, message_num, server_time, ps, entities };
        if !valid {
            return Ok(());
        }

        if self.info.snapshots == 0 {
            self.info.first_server_time = server_time;
            if self.in_warmup() && self.warmup_start.is_none() {
                self.warmup_start = Some(server_time);
            }
        }
        self.info.snapshots += 1;
        self.info.last_server_time = server_time;
        let prev = self.last_snap.replace(slot);
        self.scan_events(slot, prev);
        Ok(())
    }

    /// Finds new entity events in the snapshot (same de-duplication rules as
    /// the WolfcamQL pre-parse) and records obituaries.
    fn scan_events(&mut self, slot: usize, prev: Option<usize>) {
        let l = self.layout.as_ref().unwrap();
        let (e_type, e_event, e_flags, e_other, e_other2, e_parm, ev_obit) =
            (l.e_type, l.e_event, l.e_flags, l.e_other, l.e_other2, l.e_event_parm, l.ev_obituary);
        let snap_time = self.snapshots[slot].server_time;
        let message_num = self.snapshots[slot].message_num;
        let mut old_flags: HashMap<u16, i32> = HashMap::new();
        if let Some(p) = prev {
            if p != slot {
                for (n, f) in &self.snapshots[p].entities {
                    old_flags.insert(*n, f[e_flags]);
                }
            }
        }
        let mut found: Vec<(i32, i32, i32, i32)> = Vec::new();
        for (num, f) in &self.snapshots[slot].entities {
            let n = *num as usize;
            let stale = self.ent_snap_time[n] < snap_time - EVENT_VALID_MSEC;
            match old_flags.get(num) {
                None => {
                    if stale {
                        self.ent_prev_event[n] = 0;
                    }
                }
                Some(of) => {
                    if (of ^ f[e_flags]) & EF_TELEPORT_BIT != 0 && stale {
                        self.ent_prev_event[n] = 0;
                    }
                }
            }
            let mut number = *num as i32;
            let event;
            let mut fire = true;
            if f[e_type] > ET_EVENTS {
                if self.ent_prev_event[n] != 0 {
                    fire = false;
                }
                if f[e_flags] & EF_PLAYER_EVENT != 0 {
                    number = f[e_other];
                }
                self.ent_prev_event[n] = 1;
                event = f[e_type] - ET_EVENTS;
            } else {
                event = f[e_event];
                if event == self.ent_prev_event[n] {
                    fire = false;
                } else {
                    self.ent_prev_event[n] = event;
                    if event & !EV_EVENT_BITS == 0 {
                        fire = false;
                    }
                }
            }
            self.ent_snap_time[n] = snap_time;
            if fire && (event & !EV_EVENT_BITS) == ev_obit {
                found.push((number, f[e_other], f[e_other2], f[e_parm]));
            }
        }
        for (number, target, attacker, mod_id) in found {
            if self.is_new_obit(number, snap_time, message_num) {
                self.record_kill(snap_time, attacker, target, mod_id);
            }
        }
    }

    fn is_new_obit(&mut self, number: i32, snap_time: i32, message_num: i32) -> bool {
        for d in self.obits.iter_mut().rev() {
            if d.number == number {
                if d.last_message_num == message_num {
                    return false;
                }
                if d.last_message_num == message_num - 1 || d.first_server_time + EVENT_VALID_MSEC > snap_time {
                    d.last_message_num = message_num;
                    return false;
                }
                break;
            }
            if d.last_message_num < message_num - 2 {
                break;
            }
        }
        self.obits.push(Obit { number, first_server_time: snap_time, last_message_num: message_num });
        true
    }

    fn record_kill(&mut self, server_time: i32, attacker: i32, target: i32, mod_id: i32) {
        let victim = self.player(target);
        let killer = self.player(attacker);
        let victim_team = victim.as_ref().map(|p| p.team).unwrap_or(0);
        let killer_team = killer.as_ref().map(|p| p.team).unwrap_or(0);
        let world = attacker == ENTITYNUM_WORLD || killer.is_none();
        let own_goal = world || attacker == target; // team kills are resolved in finish()
        self.info.kills.push(Kill {
            server_time,
            clock_ms: self.clock_ms(server_time),
            warmup: self.in_warmup(),
            killer: if world { ENTITYNUM_WORLD } else { attacker },
            victim: target,
            killer_name: killer.map(|p| p.name).unwrap_or_else(|| "<world>".into()),
            victim_name: victim.map(|p| p.name).unwrap_or_else(|| format!("client {target}")),
            killer_team,
            victim_team,
            mod_id,
            weapon: weapon_label(mod_id).to_string(),
            own_goal,
        });
    }

    fn server_command(&mut self, text: &str) {
        let t = tokenize(text);
        let Some(cmd) = t.first() else { return };
        match cmd.as_str() {
            "cs" if t.len() >= 3 => {
                if let Ok(i) = t[1].parse::<usize>() {
                    if i < 1024 {
                        self.set_configstring(i, t[2].clone());
                    }
                }
            }
            "bcs0" if t.len() >= 3 => self.big_cs = t[2].clone(),
            "bcs1" if t.len() >= 3 => self.big_cs.push_str(&t[2]),
            "bcs2" if t.len() >= 3 => {
                self.big_cs.push_str(&t[2]);
                if let Ok(i) = t[1].parse::<usize>() {
                    if i < 1024 {
                        let s = std::mem::take(&mut self.big_cs);
                        self.set_configstring(i, s);
                    }
                }
            }
            "chat" | "tchat" if t.len() >= 2 => {
                let st = self.current_time();
                let mut text = strip_colors(&t[1]).replace('\u{19}', "").trim().to_string();
                // Quake Live prefixes chat with the two-digit client number.
                let b = text.as_bytes();
                if b.len() > 3 && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[2] == b' ' {
                    text = text[3..].to_string();
                }
                if !text.is_empty() && self.info.chats.len() < 5000 {
                    self.info.chats.push(Chat { server_time: st, clock_ms: self.clock_ms(st), team: cmd == "tchat", text });
                }
            }
            _ => {}
        }
    }

    fn parse_message(&mut self, data: &[u8], sequence: i32) -> Result<(), String> {
        let mut msg = Msg::new(data);
        msg.read_long(); // reliable acknowledge
        loop {
            if msg.overflow {
                return Err("message ended early".into());
            }
            let cmd = msg.read_byte();
            match cmd {
                SVC_EOF | -1 => break,
                SVC_NOP => {}
                SVC_SERVERCOMMAND => {
                    let seq = msg.read_long();
                    let s = msg.read_string(self.high_ascii());
                    if seq > self.last_command_seq {
                        self.last_command_seq = seq;
                        self.server_command(&s);
                    }
                }
                SVC_GAMESTATE => self.parse_gamestate(&mut msg)?,
                SVC_SNAPSHOT => self.parse_snapshot(&mut msg, sequence)?,
                // Downloads and voice data never matter for a demo summary; the rest
                // of such a message cannot be skipped reliably, so stop here.
                _ => break,
            }
        }
        Ok(())
    }

    fn finish(mut self) -> DemoInfo {
        let serverinfo = self.cs(0).to_string();
        let info = &mut self.info;
        info.protocol = self.protocol;
        info.map = info_value(&serverinfo, "mapname").unwrap_or("").to_string();
        info.gametype = info_value(&serverinfo, "g_gametype").and_then(|g| g.parse().ok()).unwrap_or(0);
        info.gametype_name = gametype_name(self.protocol, info.gametype).to_string();
        info.hostname = strip_colors(info_value(&serverinfo, "sv_hostname").unwrap_or(""));
        info.timestamp = info_value(&serverinfo, "g_levelStartTime").and_then(|t| t.parse().ok()).filter(|t: &i64| *t > 0);
        info.pov_client = self.client_num;
        info.duration_ms = (info.last_server_time - info.first_server_time).max(0);
        info.players = std::mem::take(&mut self.seen_players);
        info.pov_name = info
            .players
            .iter()
            .rev()
            .find(|p| p.client_num == self.client_num)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        // Anything before the match started counts as warmup, whatever the
        // server's warmup flag said (old Quake Live demos do not set it).
        let (first, game_start) = (info.first_server_time, info.game_start_time);
        let pre_game = |t: i32| game_start.map(|gs| t < gs).unwrap_or(false);
        for c in &mut info.chats {
            if pre_game(c.server_time) {
                c.clock_ms = c.server_time - first;
            }
        }
        if info.kills.iter().any(|k| pre_game(k.server_time)) {
            info.has_warmup = true;
        }
        // Team-kill detection needs the gametype, which is only final here.
        let team_game = info.gametype >= 3;
        for k in &mut info.kills {
            if pre_game(k.server_time) {
                k.warmup = true;
                k.clock_ms = k.server_time - first;
            }
            k.own_goal = k.killer == ENTITYNUM_WORLD
                || k.killer == k.victim
                || (team_game && k.killer_team == k.victim_team && k.killer_team != 0);
        }
        self.info
    }
}

fn protocol_from_extension(path: &std::path::Path) -> i32 {
    path.extension()
        .and_then(|e| e.to_str())
        .and_then(|e| e.to_ascii_lowercase().strip_prefix("dm_").and_then(|n| n.parse().ok()))
        .unwrap_or(91)
}

pub fn is_demo_file(path: &std::path::Path) -> bool {
    matches!(protocol_from_extension(path), 66..=71 | 73 | 90 | 91)
        && path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase().starts_with("dm_")).unwrap_or(false)
}

pub fn parse_bytes(data: &[u8], ext_protocol: i32) -> Result<DemoInfo, String> {
    let mut p = Parser::new(ext_protocol);
    let mut pos = 0usize;
    let mut warning = None;
    let mut got_gamestate = false;
    loop {
        if pos + 8 > data.len() {
            if pos != data.len() {
                warning = Some("file is truncated".to_string());
            }
            break;
        }
        let seq = i32::from_le_bytes(data[pos..pos + 4].try_into().unwrap());
        let len = i32::from_le_bytes(data[pos + 4..pos + 8].try_into().unwrap());
        pos += 8;
        if seq == -1 || len == -1 {
            break;
        }
        if !(0..=49152).contains(&len) {
            warning = Some(format!("bad message length {len}"));
            break;
        }
        let end = pos + len as usize;
        if end > data.len() {
            warning = Some("file is truncated".to_string());
            break;
        }
        match p.parse_message(&data[pos..end], seq) {
            Ok(()) => got_gamestate |= p.layout.is_some(),
            Err(e) => {
                if !got_gamestate {
                    return Err(e);
                }
                warning.get_or_insert(e);
            }
        }
        pos = end;
    }
    if !got_gamestate {
        return Err("not a supported Quake 3 / Quake Live demo".into());
    }
    let mut info = p.finish();
    info.warning = warning;
    Ok(info)
}

pub fn parse_file(path: &std::path::Path) -> Result<DemoInfo, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    parse_bytes(&data, protocol_from_extension(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_colour_codes() {
        assert_eq!(strip_colors("^1Red^7Name"), "RedName");
        assert_eq!(strip_colors("plain"), "plain");
    }

    #[test]
    fn reads_info_strings() {
        let s = "\\mapname\\qzdm6\\g_gametype\\1";
        assert_eq!(info_value(s, "mapname"), Some("qzdm6"));
        assert_eq!(info_value(s, "G_GAMETYPE"), Some("1"));
        assert_eq!(info_value("n\\Player\\t\\2", "t"), Some("2"));
        assert_eq!(info_value(s, "missing"), None);
    }

    #[test]
    fn tokenizes_server_commands() {
        assert_eq!(tokenize("cs 529 \"n\\Foo Bar\\t\\1\""), vec!["cs", "529", "n\\Foo Bar\\t\\1"]);
        assert_eq!(tokenize("chat \"a: hi there\""), vec!["chat", "a: hi there"]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_bytes(b"definitely not a demo file at all", 91).is_err());
        assert!(parse_bytes(&[], 91).is_err());
    }
}
