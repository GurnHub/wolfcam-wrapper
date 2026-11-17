//! Locating WolfcamQL, its home directory, Quake Live and ffmpeg, plus the
//! pak check / sync that WolfcamQL needs before it can play Quake Live demos.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Sub-directory of both the install and the home directory that holds
/// WolfcamQL's own files (configs, videos, cameras, huds).
pub const GAME_DIR: &str = "wolfcam-ql";
/// Where WolfDeck keeps the files it generates inside `GAME_DIR`.
pub const DECK_DIR: &str = "wolfdeck";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub wolfcam_exe: Vec<String>,
    pub wolfcam_home: String,
    pub quake_live: Vec<String>,
    pub demo_dirs: Vec<String>,
    pub ffmpeg: Option<String>,
}

fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["wolfcamql.exe", "wolfcamql64.exe", "ioquake3.exe"]
    } else if cfg!(target_os = "macos") {
        &["wolfcamqlmac", "wolfcamql"]
    } else {
        &["wolfcamql.x86_64", "wolfcamql", "wolfcamql.i386", "ioquake3"]
    }
}

/// The home path WolfcamQL uses when `fs_homepath` is not set.
pub fn default_home() -> PathBuf {
    if cfg!(windows) {
        dirs::config_dir().unwrap_or_default().join("wolfcamql")
    } else if cfg!(target_os = "macos") {
        dirs::home_dir().unwrap_or_default().join("Library/Application Support/wolfcamql")
    } else {
        let home = dirs::home_dir().unwrap_or_default();
        let legacy = home.join(".wolfcamql");
        if legacy.is_dir() {
            legacy
        } else {
            dirs::data_dir().unwrap_or_else(|| home.join(".local/share")).join("wolfcamql")
        }
    }
}

fn steam_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(windows) {
        for d in ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam", "D:\\Steam", "D:\\SteamLibrary", "E:\\SteamLibrary"] {
            v.push(PathBuf::from(d));
        }
    } else if let Some(h) = dirs::home_dir() {
        v.push(h.join(".steam/steam"));
        v.push(h.join(".local/share/Steam"));
        v.push(h.join("Library/Application Support/Steam"));
        v.push(h.join(".wine/drive_c/Program Files (x86)/Steam"));
    }
    v
}

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) && !name.ends_with(".exe") { format!("{name}.exe") } else { name.to_string() };
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(&exe)).find(|c| c.is_file()))
}

pub fn detect() -> Detected {
    let mut d = Detected { wolfcam_home: default_home().to_string_lossy().into_owned(), ..Default::default() };

    let mut exe_dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = dirs::home_dir() {
        for sub in ["wolfcamql", "Games/wolfcamql", "Desktop/wolfcamql", "Downloads/wolfcamql", "Documents/wolfcamql"] {
            exe_dirs.push(h.join(sub));
        }
    }
    if cfg!(windows) {
        for p in ["C:\\wolfcamql", "C:\\Games\\wolfcamql", "C:\\Program Files\\wolfcamql", "C:\\Program Files (x86)\\wolfcamql", "D:\\wolfcamql", "D:\\Games\\wolfcamql"] {
            exe_dirs.push(PathBuf::from(p));
        }
    }
    for dir in exe_dirs {
        for n in exe_names() {
            let c = dir.join(n);
            if c.is_file() {
                d.wolfcam_exe.push(c.to_string_lossy().into_owned());
            }
        }
    }
    for n in exe_names() {
        if let Some(p) = find_in_path(n) {
            d.wolfcam_exe.push(p.to_string_lossy().into_owned());
        }
    }

    for root in steam_roots() {
        let ql = root.join("steamapps/common/Quake Live");
        if ql.join("baseq3").is_dir() {
            d.quake_live.push(ql.to_string_lossy().into_owned());
            // Steam keeps per-account data, including recorded demos, in <steamid64>/baseq3.
            if let Ok(rd) = std::fs::read_dir(&ql) {
                for e in rd.flatten() {
                    let demos = e.path().join("baseq3/demos");
                    if demos.is_dir() {
                        d.demo_dirs.push(demos.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    let home_demos = default_home().join(GAME_DIR).join("demos");
    if home_demos.is_dir() {
        d.demo_dirs.push(home_demos.to_string_lossy().into_owned());
    }
    d.ffmpeg = find_in_path("ffmpeg").map(|p| p.to_string_lossy().into_owned());
    d
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub exe_ok: bool,
    pub base_dir: String,
    pub home: String,
    pub game_dir_ok: bool,
    /// pk3 files found in the install's and the home's baseq3.
    pub paks: Vec<String>,
    /// True when the core Quake Live pak (pak00.pk3) is available to WolfcamQL.
    pub has_core_pak: bool,
    /// pk3 files in the Quake Live install that WolfcamQL does not have yet.
    pub missing_paks: Vec<String>,
    pub ql_ok: bool,
    pub problems: Vec<String>,
}

fn pk3s(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().map(|x| x.eq_ignore_ascii_case("pk3")).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

pub fn resolve_home(home: &str) -> PathBuf {
    if home.trim().is_empty() { default_home() } else { PathBuf::from(home.trim()) }
}

pub fn check_install(exe: &str, home: &str, ql_path: &str) -> InstallStatus {
    let mut s = InstallStatus::default();
    let exe_path = Path::new(exe);
    s.exe_ok = !exe.is_empty() && exe_path.is_file();
    let home = resolve_home(home);
    s.home = home.to_string_lossy().into_owned();
    if !s.exe_ok {
        s.problems.push("WolfcamQL executable not found. Set its location in Settings.".into());
        return s;
    }
    let base = exe_path.parent().unwrap_or(Path::new(".")).to_path_buf();
    s.base_dir = base.to_string_lossy().into_owned();
    s.game_dir_ok = base.join(GAME_DIR).is_dir();
    if !s.game_dir_ok {
        s.problems.push(format!("No '{GAME_DIR}' folder next to the executable; this does not look like a WolfcamQL install."));
    }
    let mut have: Vec<String> = pk3s(&base.join("baseq3"));
    have.extend(pk3s(&home.join("baseq3")));
    have.sort();
    have.dedup();
    s.has_core_pak = have.iter().any(|p| p.eq_ignore_ascii_case("pak00.pk3") || p.eq_ignore_ascii_case("pak0.pk3"));
    let ql_base = Path::new(ql_path).join("baseq3");
    s.ql_ok = !ql_path.is_empty() && ql_base.is_dir();
    if s.ql_ok {
        s.missing_paks = pk3s(&ql_base).into_iter().filter(|p| !have.iter().any(|h| h.eq_ignore_ascii_case(p))).collect();
    }
    if !s.has_core_pak {
        s.problems.push(if s.ql_ok {
            "Quake Live paks have not been copied into WolfcamQL's baseq3 yet. Use Sync paks.".into()
        } else {
            "WolfcamQL has no Quake Live paks in baseq3 and no Quake Live install is configured.".into()
        });
    } else if !s.missing_paks.is_empty() {
        s.problems.push(format!("{} pak file(s) from Quake Live are not in WolfcamQL yet (maps may be missing).", s.missing_paks.len()));
    }
    s.paks = have;
    s
}

/// Copies pk3 files that WolfcamQL is missing from the Quake Live install
/// into `<wolfcam>/baseq3`, falling back to `<home>/baseq3` when the install
/// directory is not writable. Returns the names that were copied.
pub fn sync_paks(exe: &str, home: &str, ql_path: &str) -> Result<Vec<String>, String> {
    let status = check_install(exe, home, ql_path);
    if !status.exe_ok {
        return Err("WolfcamQL executable not found".into());
    }
    if !status.ql_ok {
        return Err("Quake Live folder not found (it must contain baseq3)".into());
    }
    let src = Path::new(ql_path).join("baseq3");
    let mut dest = Path::new(&status.base_dir).join("baseq3");
    if std::fs::create_dir_all(&dest).is_err() || std::fs::write(dest.join(".wolfdeck-write-test"), b"").is_err() {
        dest = resolve_home(home).join("baseq3");
        std::fs::create_dir_all(&dest).map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    } else {
        let _ = std::fs::remove_file(dest.join(".wolfdeck-write-test"));
    }
    let mut copied = Vec::new();
    for name in status.missing_paks {
        std::fs::copy(src.join(&name), dest.join(&name)).map_err(|e| format!("copying {name}: {e}"))?;
        copied.push(name);
    }
    Ok(copied)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

/// Lists files with one of `exts` in `<base>/wolfcam-ql/<sub>` and `<home>/wolfcam-ql/<sub>`.
pub fn list_game_files(exe: &str, home: &str, sub: &str, exts: &[&str]) -> Vec<GameFile> {
    let mut out: Vec<GameFile> = Vec::new();
    let mut roots = vec![resolve_home(home).join(GAME_DIR)];
    if let Some(base) = Path::new(exe).parent() {
        roots.push(base.join(GAME_DIR));
    }
    for root in roots {
        let dir = if sub.is_empty() { root } else { root.join(sub) };
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if !p.is_file() || !exts.contains(&ext.as_str()) {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if out.iter().any(|f| f.name == name) {
                continue; // the home copy shadows the install copy, as in the engine
            }
            let md = e.metadata().ok();
            out.push(GameFile {
                name,
                path: p.to_string_lossy().into_owned(),
                size: md.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: md
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            });
        }
    }
    out.sort_by_key(|f| f.name.to_lowercase());
    out
}

/// Makes a HUD `.menu` file usable as `cg_hudFiles`: copies it into
/// `<home>/wolfcam-ql/ui` when it lives outside WolfcamQL's folders and
/// writes the small list file the engine expects. Returns the value for
/// `cg_hudFiles`.
pub fn install_hud(exe: &str, home: &str, menu: &str) -> Result<String, String> {
    let src = Path::new(menu);
    if !src.is_file() {
        return Err(format!("HUD file not found: {menu}"));
    }
    if !src.extension().map(|e| e.eq_ignore_ascii_case("menu")).unwrap_or(false) {
        return Err("HUD files have the extension .menu".into());
    }
    let game_home = resolve_home(home).join(GAME_DIR);
    let mut roots = vec![game_home.clone()];
    if let Some(base) = Path::new(exe).parent() {
        roots.push(base.join(GAME_DIR));
    }
    let name = src.file_name().unwrap().to_string_lossy().into_owned();
    // Path of the menu as the engine's file system sees it.
    let relative = roots
        .iter()
        .find_map(|root| src.strip_prefix(root).ok())
        .map(|rel| rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
    let relative = match relative {
        Some(r) => r,
        None => {
            let ui = game_home.join("ui");
            std::fs::create_dir_all(&ui).map_err(|e| e.to_string())?;
            std::fs::copy(src, ui.join(&name)).map_err(|e| format!("copying {name}: {e}"))?;
            format!("ui/{name}")
        }
    };
    if relative.contains('"') {
        return Err("HUD file names cannot contain quotes".into());
    }
    let stem: String = Path::new(&name)
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let deck = game_home.join(DECK_DIR);
    std::fs::create_dir_all(&deck).map_err(|e| e.to_string())?;
    let list = format!("// Generated by WolfDeck\n{{\n\tloadMenu {{ \"{relative}\" }}\n}}\n");
    std::fs::write(deck.join(format!("hud-{stem}.cfg")), list).map_err(|e| e.to_string())?;
    Ok(format!("{DECK_DIR}/hud-{stem}.cfg"))
}

/// Parses `bind <key> "<command>"` lines as the engine writes them to its config.
pub fn parse_binds(config: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("bind ").or_else(|| line.strip_prefix("BIND ")) else { continue };
        let rest = rest.trim_start();
        let Some(split) = rest.find(char::is_whitespace) else { continue };
        let (key, command) = rest.split_at(split);
        let command = command.trim();
        let command = command.strip_prefix('"').and_then(|c| c.strip_suffix('"')).unwrap_or(command);
        if command.is_empty() {
            continue;
        }
        // A later bind of the same key replaces the earlier one, as in the engine.
        out.retain(|(k, _)| !k.eq_ignore_ascii_case(key));
        out.push((key.to_string(), command.to_string()));
    }
    out
}

/// The key binds WolfcamQL currently has saved (`q3config.cfg` in its home).
pub fn read_binds(home: &str) -> Result<Vec<(String, String)>, String> {
    let file = resolve_home(home).join(GAME_DIR).join("q3config.cfg");
    let text = std::fs::read(&file).map_err(|_| format!("{} not found. Start WolfcamQL once so it writes its config.", file.display()))?;
    Ok(parse_binds(&String::from_utf8_lossy(&text)))
}

/// Maps (lower-case names, e.g. "campgrounds") found in the given pk3
/// files and in loose `maps/*.bsp` files of the given folders.
fn maps_in(dirs: &[PathBuf], pk3s: &[PathBuf]) -> std::collections::BTreeSet<String> {
    let mut maps = std::collections::BTreeSet::new();
    let mut add = |entry: &str| {
        let e = entry.replace('\\', "/").to_ascii_lowercase();
        if let Some(name) = e.strip_prefix("maps/").and_then(|n| n.strip_suffix(".bsp")) {
            if !name.contains('/') && !name.is_empty() {
                maps.insert(name.to_string());
            }
        }
    };
    for pk3 in pk3s {
        // Only the zip directory is read, not the contents.
        let Ok(file) = std::fs::File::open(pk3) else { continue };
        let Ok(archive) = zip::ZipArchive::new(std::io::BufReader::new(file)) else { continue };
        for name in archive.file_names() {
            add(name);
        }
    }
    for dir in dirs {
        if let Ok(rd) = std::fs::read_dir(dir.join("maps")) {
            for e in rd.flatten() {
                add(&format!("maps/{}", e.file_name().to_string_lossy()));
            }
        }
    }
    maps
}

/// The maps WolfcamQL can load: its own `baseq3` and `wolfcam-ql` folders
/// (install and home), its workshop download folder, and Quake Live's Steam
/// Workshop content, which WolfcamQL also searches.
pub fn installed_maps(exe: &str, home: &str, ql_path: &str) -> Vec<String> {
    let home = resolve_home(home);
    let mut dirs: Vec<PathBuf> = vec![home.join("baseq3"), home.join(GAME_DIR)];
    if let Some(base) = Path::new(exe).parent().filter(|_| !exe.is_empty()) {
        dirs.push(base.join("baseq3"));
        dirs.push(base.join(GAME_DIR));
    }
    let mut pk3s: Vec<PathBuf> = Vec::new();
    let mut take_pk3s = |dir: &Path, depth: usize| {
        for e in walkdir::WalkDir::new(dir).max_depth(depth).into_iter().flatten() {
            if e.file_type().is_file() && e.path().extension().map(|x| x.eq_ignore_ascii_case("pk3")).unwrap_or(false) {
                pk3s.push(e.into_path());
            }
        }
    };
    for d in &dirs {
        take_pk3s(d, 1);
    }
    take_pk3s(&home.join("workshop"), 3);
    if !ql_path.trim().is_empty() {
        // <steam>/steamapps/common/Quake Live -> <steam>/steamapps/workshop/content/282440
        if let Some(steamapps) = Path::new(ql_path.trim()).parent().and_then(|p| p.parent()) {
            take_pk3s(&steamapps.join("workshop/content/282440"), 2);
        }
    }
    maps_in(&dirs, &pk3s).into_iter().collect()
}

/// Bytes available to the current user on the volume holding `path`.
pub fn disk_free(path: &Path) -> Option<u64> {
    let mut p = path;
    while !p.exists() {
        p = p.parent()?;
    }
    fs4::available_space(p).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_check_and_pak_sync() {
        let t = std::env::temp_dir().join(format!("wolfdeck-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let wc = t.join("wolfcam");
        let ql = t.join("ql");
        let home = t.join("home");
        std::fs::create_dir_all(wc.join(GAME_DIR)).unwrap();
        std::fs::create_dir_all(ql.join("baseq3")).unwrap();
        std::fs::write(wc.join("wolfcamql"), b"x").unwrap();
        std::fs::write(ql.join("baseq3/pak00.pk3"), b"pak").unwrap();
        std::fs::write(ql.join("baseq3/bin.pk3"), b"bin").unwrap();
        let exe = wc.join("wolfcamql").to_string_lossy().into_owned();
        let (h, q) = (home.to_string_lossy().into_owned(), ql.to_string_lossy().into_owned());

        let s = check_install(&exe, &h, &q);
        assert!(s.exe_ok && s.game_dir_ok && s.ql_ok);
        assert!(!s.has_core_pak);
        assert_eq!(s.missing_paks, vec!["bin.pk3", "pak00.pk3"]);

        let copied = sync_paks(&exe, &h, &q).unwrap();
        assert_eq!(copied.len(), 2);
        let s = check_install(&exe, &h, &q);
        assert!(s.has_core_pak && s.missing_paks.is_empty() && s.problems.is_empty());
        assert!(!check_install("", &h, &q).exe_ok);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn maps_are_found_in_pk3s_and_folders() {
        use std::io::Write;
        let t = std::env::temp_dir().join(format!("wolfdeck-maps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let home = t.join("home");
        let base = t.join("wc");
        let ql = t.join("steam/steamapps/common/Quake Live");
        for d in [home.join("baseq3"), base.join(GAME_DIR).join("maps"), ql.clone(), t.join("steam/steamapps/workshop/content/282440/12345")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let write_pk3 = |path: PathBuf, entries: &[&str]| {
            let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
            for e in entries {
                z.start_file(*e, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
                z.write_all(b"x").unwrap();
            }
            z.finish().unwrap();
        };
        write_pk3(home.join("baseq3/pak00.pk3"), &["maps/Campgrounds.bsp", "maps/bloodrun.bsp", "textures/x.tga", "maps/sub/no.bsp"]);
        write_pk3(t.join("steam/steamapps/workshop/content/282440/12345/w.pk3"), &["maps/workshopmap.bsp"]);
        std::fs::write(base.join(GAME_DIR).join("maps/looseone.bsp"), b"x").unwrap();
        std::fs::write(base.join("wolfcamql"), b"x").unwrap();
        let maps = installed_maps(&base.join("wolfcamql").to_string_lossy(), &home.to_string_lossy(), &ql.to_string_lossy());
        assert_eq!(maps, vec!["bloodrun", "campgrounds", "looseone", "workshopmap"]);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn binds_are_read_from_engine_config() {
        let cfg = "// generated by quake, do not modify\nunbindall\nbind SPACE \"pause\"\nbind u \"selectcamerapoint last; deletecamerapoint\"\nbind [ \"editcamerapoint previous\"\nseta cg_fov \"100\"\nbind SEMICOLON +scores\nbind space \"freecam\"\nbind x \"\"\n";
        let b = parse_binds(cfg);
        assert_eq!(
            b,
            vec![
                ("u".to_string(), "selectcamerapoint last; deletecamerapoint".to_string()),
                ("[".to_string(), "editcamerapoint previous".to_string()),
                ("SEMICOLON".to_string(), "+scores".to_string()),
                ("space".to_string(), "freecam".to_string()),
            ]
        );
        assert!(read_binds("/nonexistent/wolfdeck/home").is_err());
    }

    #[test]
    fn hud_install_writes_a_list_file() {
        let t = std::env::temp_dir().join(format!("wolfdeck-hud-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let home = t.join("home");
        let base = t.join("wolfcam");
        std::fs::create_dir_all(base.join(GAME_DIR).join("ui")).unwrap();
        std::fs::create_dir_all(t.join("downloads")).unwrap();
        let exe = base.join("wolfcamql").to_string_lossy().into_owned();
        let h = home.to_string_lossy().into_owned();

        // A HUD already inside WolfcamQL is referenced in place.
        let inside = base.join(GAME_DIR).join("ui").join("pro hud.menu");
        std::fs::write(&inside, "menuDef {}").unwrap();
        let value = install_hud(&exe, &h, &inside.to_string_lossy()).unwrap();
        assert_eq!(value, "wolfdeck/hud-pro_hud.cfg");
        let list = std::fs::read_to_string(home.join(GAME_DIR).join(&value)).unwrap();
        assert!(list.contains("loadMenu { \"ui/pro hud.menu\" }"), "{list}");

        // One from elsewhere is copied into the home ui folder first.
        let outside = t.join("downloads").join("my.menu");
        std::fs::write(&outside, "menuDef {}").unwrap();
        assert_eq!(install_hud(&exe, &h, &outside.to_string_lossy()).unwrap(), "wolfdeck/hud-my.cfg");
        assert!(home.join(GAME_DIR).join("ui/my.menu").is_file());

        assert!(install_hud(&exe, &h, &t.join("missing.menu").to_string_lossy()).is_err());
        std::fs::write(t.join("notes.txt"), "x").unwrap();
        assert!(install_hud(&exe, &h, &t.join("notes.txt").to_string_lossy()).is_err());
        assert!(disk_free(&t.join("does/not/exist/yet")).unwrap() > 0);
        let _ = std::fs::remove_dir_all(&t);
    }
}
