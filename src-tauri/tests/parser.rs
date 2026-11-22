//! Parses an excerpt of a real Quake Live demo (the first minute of
//! `christian-lime-aimbot.dm_73`, a sample demo distributed with WolfcamQL).
//! Expected values were cross-checked against WolfcamQL's own demo pre-parse.

use wolfcam_wrapper_lib::demo::parse_file;
use wolfcam_wrapper_lib::library::{find_frags, FragFilter};

fn fixture() -> wolfcam_wrapper_lib::demo::DemoInfo {
    parse_file(std::path::Path::new("tests/fixtures/ffa-excerpt.dm_73")).expect("fixture parses")
}

#[test]
fn reads_match_metadata() {
    let d = fixture();
    assert_eq!(d.protocol, 73);
    assert_eq!(d.map, "qzdm15");
    assert_eq!(d.gametype_name, "FFA");
    assert_eq!(d.hostname, "Free For All");
    assert_eq!(d.timestamp, Some(1264200417));
    assert_eq!(d.pov_name, "GB1Minions1PooP");
    assert_eq!(d.first_server_time, 56361800);
    assert_eq!(d.game_start_time, Some(56370650));
    assert_eq!(d.snapshots, 2254);
    assert!(d.warning.is_none());
    assert_eq!(d.players.len(), 16);
    assert!(d.players.iter().any(|p| p.name == "ChristianLime" && p.team == 0));
    assert!(d.players.iter().any(|p| p.name == "GB1Minions1PooP" && p.team == 3), "demo taker is a spectator");
}

#[test]
fn reads_kills_and_chat() {
    let d = fixture();
    assert_eq!(d.kills.len(), 38);
    let first = &d.kills[0];
    assert!(first.warmup && first.own_goal && first.killer_name == "<world>" && first.weapon == "Trigger");
    let k = d.kills.iter().find(|k| !k.warmup).unwrap();
    assert_eq!((k.server_time, k.clock_ms), (56374325, 3675));
    assert_eq!((k.killer_name.as_str(), k.victim_name.as_str(), k.weapon.as_str()), ("FBAnder", "sevenseeds", "SG"));
    assert!(d.kills.windows(2).all(|w| w[0].server_time <= w[1].server_time));
    assert_eq!(d.chats[0].text, "sevenseeds: thats ok imo at least he knows hes bad haha");
}

#[test]
fn finds_multi_kills() {
    let d = fixture();
    let every = FragFilter { min_kills: 1, window_ms: 0, ..Default::default() };
    let singles = find_frags(&d, "x.dm_73", &every);
    let real_kills = d.kills.iter().filter(|k| !k.warmup && !k.own_goal).count();
    assert_eq!(singles.iter().map(|f| f.kills.len()).sum::<usize>(), real_kills);
    let doubles = FragFilter { min_kills: 2, window_ms: 5000, ..Default::default() };
    for f in find_frags(&d, "x.dm_73", &doubles) {
        assert!(f.kills.len() >= 2);
        assert!(f.kills.windows(2).all(|w| w[1].server_time - w[0].server_time <= 5000 && w[0].killer == w[1].killer));
    }
}

#[test]
fn truncated_file_still_yields_data() {
    let bytes = std::fs::read("tests/fixtures/ffa-excerpt.dm_73").unwrap();
    let d = wolfcam_wrapper_lib::demo::parser::parse_bytes(&bytes[..bytes.len() / 2], 73).unwrap();
    assert_eq!(d.map, "qzdm15");
    assert!(d.warning.is_some());
    assert!(d.snapshots > 500);
}
