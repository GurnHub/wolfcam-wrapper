//! Launching WolfcamQL and talking to it while it runs.
//!
//! WolfcamQL has no remote-control API, so WolfDeck uses what the engine
//! offers:
//!
//! * **Start-up**: the command line stays minimal (the engine caps it at
//!   1023 characters and 32 commands). Cvars go into `wolfdeck/pre.cfg`,
//!   executed before the demo loads, and everything else into
//!   `wolfdeck/session.cfg`, executed once the demo has loaded.
//! * **Live commands**: each batch is written to a `wolfdeck/b<slot>.cfg`
//!   file and listed in `wolfdeck/cmd.cfg`, guarded by a sequence cvar so a
//!   batch runs exactly once no matter how often the file is executed. The engine is
//!   then told to execute `cmd.cfg`: on Linux/macOS through its command pipe
//!   (`com_pipefile`), on Windows by posting a key press to its window for a
//!   key that WolfDeck binds to `execq wolfdeck/cmd.cfg`.
//! * **Feedback**: the engine console is mirrored to `qconsole.log`
//!   (`logfile 2`), which is tailed here.

use crate::paths::{resolve_home, DECK_DIR, GAME_DIR};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PIPE_NAME: &str = "wolfdeck.pipe";
/// How many recent batches stay listed in cmd.cfg. Batch files and the
/// cvars that reference them are reused in a ring of this size, so the engine
/// may fall this many batches behind (e.g. while loading) without losing any.
const BATCH_WINDOW: u64 = 64;

/// Receives events destined for the UI.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchSpec {
    pub exe: String,
    /// `fs_homepath`; empty selects the platform default.
    pub home: String,
    /// Cvars applied before the demo loads: resolution, renderer and capture
    /// settings, and the config profile (the game module reads some of it,
    /// such as the HUD file, only while it starts). The video system is
    /// restarted first when a latched value differs from the saved config.
    pub cvars: Vec<(String, String)>,
    pub demo: Option<String>,
    /// Config text executed after the demo has loaded.
    pub config: String,
    pub extra_args: Vec<String>,
    /// Key used to trigger command execution on Windows, e.g. "F13".
    pub control_key: String,
}

pub fn game_home(home: &str) -> PathBuf {
    resolve_home(home).join(GAME_DIR)
}

pub fn deck_dir(home: &str) -> PathBuf {
    game_home(home).join(DECK_DIR)
}

/// The engine splits its command line on '+', so an argument containing one
/// must be quoted. Arguments with spaces are quoted by the engine itself.
fn engine_arg(s: &str) -> String {
    if s.contains('+') && !s.contains(' ') && !s.starts_with('"') {
        format!("\"{s}\"")
    } else {
        s.to_string()
    }
}

/// Cvar values and names end up inside an engine command line; refuse
/// characters that would start another command.
fn clean_token(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '"' | ';' | '\n' | '\r')).collect()
}

/// Value of an archived cvar in the engine's saved config, if present.
fn saved_cvar<'a>(q3config: &'a str, name: &str) -> Option<&'a str> {
    q3config.lines().find_map(|line| {
        let mut it = line.trim().splitn(3, char::is_whitespace);
        let (cmd, key, value) = (it.next()?, it.next()?, it.next()?);
        (cmd.eq_ignore_ascii_case("seta") && key.eq_ignore_ascii_case(name)).then(|| value.trim().trim_matches('"'))
    })
}

/// Cvars the engine latches: a new value only takes effect after
/// `vid_restart` (checked against the WolfcamQL source). The UI marks the
/// same set; keep `src/lib/cvars.ts` in step.
pub const LATCHED: &[&str] = &[
    "cl_renderer", "r_mode", "r_customwidth", "r_customheight", "r_noborder", "r_picmip", "r_overbrightbits",
    "r_mapoverbrightbits", "r_intensity", "r_fullbright", "r_vertexlight", "r_greyscale", "r_mapgreyscale",
    "r_ext_multisample", "r_ext_max_anisotropy", "r_usefbo", "r_fboantialias", "r_enablepostprocess",
    "r_enablecolorcorrect", "r_swapinterval", "s_useopenal",
];

/// Renderer cvars known to apply immediately.
const LIVE_RENDERER: &[&str] = &[
    "r_fullscreen", "r_gamma", "r_fastsky", "r_dynamiclight", "r_flares", "r_contrast", "r_enablebloom", "r_bloomintensity",
];

pub fn is_latched(name: &str) -> bool {
    let k = name.to_ascii_lowercase();
    // Renderer cvars this list does not know are treated as latched, which at worst costs one restart.
    LATCHED.contains(&k.as_str()) || (k.starts_with("r_") && !LIVE_RENDERER.contains(&k.as_str()))
}

/// Returns true when the saved engine config would start the engine with a
/// different value for a latched cvar than the one requested.
pub fn needs_video_restart(spec: &LaunchSpec) -> bool {
    let q3config = std::fs::read_to_string(game_home(&spec.home).join("q3config.cfg")).unwrap_or_default();
    spec.cvars.iter().any(|(k, v)| is_latched(k) && saved_cvar(&q3config, k).map(|saved| saved != v.as_str()).unwrap_or(true))
}

pub fn build_args(spec: &LaunchSpec) -> Result<Vec<String>, String> {
    let home = resolve_home(&spec.home);
    let mut a: Vec<String> = vec!["+set".into(), "fs_homepath".into(), engine_arg(&home.to_string_lossy())];
    for (k, v) in [("logfile", "2"), ("wd_seq", "0")] {
        a.extend(["+set".into(), k.into(), v.into()]);
    }
    if cfg!(unix) {
        a.extend(["+set".into(), "com_pipefile".into(), PIPE_NAME.into()]);
    }
    a.extend(spec.extra_args.iter().filter(|s| !s.trim().is_empty()).cloned());
    if spec.cvars.iter().any(|(k, _)| !clean_token(k).is_empty()) {
        a.extend(["+exec".into(), format!("{DECK_DIR}/pre.cfg")]);
        if needs_video_restart(spec) {
            a.push("+vid_restart".into());
        }
    }
    if let Some(demo) = spec.demo.as_ref().filter(|d| !d.is_empty()) {
        a.extend(["+demo".into(), engine_arg(demo)]);
    }
    a.extend(["+exec".into(), format!("{DECK_DIR}/session.cfg")]);
    // Engine limits: 1023 characters in total (it aborts beyond that) and 32 '+' commands.
    let length: usize = a.iter().map(|s| s.len() + 3).sum();
    let commands = a.iter().filter(|s| s.starts_with('+')).count();
    if length > 1000 || commands > 30 {
        return Err("The WolfcamQL command line would be too long. Shorten the extra arguments or move the demo to a shorter path.".into());
    }
    Ok(a)
}

fn key_bind_line(control_key: &str) -> String {
    let key = if control_key.trim().is_empty() { "F13" } else { control_key.trim() };
    format!("bind {} \"execq {DECK_DIR}/cmd.cfg\"\n", clean_token(key))
}

/// Writes the generated config files and removes leftovers of older sessions.
pub fn prepare_files(spec: &LaunchSpec) -> Result<PathBuf, String> {
    let dir = deck_dir(&spec.home);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with('b') && n.ends_with(".cfg") && n[1..n.len() - 4].chars().all(|c| c.is_ascii_digit()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let mut cfg = String::from("// Generated by WolfDeck for the current session. Changes are overwritten.\n");
    if cfg!(windows) {
        cfg.push_str(&key_bind_line(&spec.control_key));
    }
    cfg.push_str(&spec.config);
    cfg.push_str("\necho WD_READY\n");
    let mut pre = String::from("// Generated by WolfDeck: settings applied before the demo loads.\n");
    for (k, v) in &spec.cvars {
        let (k, v) = (clean_token(k), clean_token(v));
        if !k.is_empty() {
            pre.push_str(&format!("set {k} \"{v}\"\n"));
        }
    }
    std::fs::write(dir.join("pre.cfg"), pre).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("session.cfg"), cfg).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("cmd.cfg"), "// no commands yet\n").map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn spawn(spec: &LaunchSpec) -> Result<Child, String> {
    let exe = Path::new(&spec.exe);
    if !exe.is_file() {
        return Err(format!("WolfcamQL executable not found: {}", spec.exe));
    }
    let args = build_args(spec)?;
    prepare_files(spec)?;
    // Start with a fresh log so the tail only ever sees this session.
    let _ = std::fs::remove_file(game_home(&spec.home).join("qconsole.log"));
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map_err(|e| format!("failed to start WolfcamQL: {e}"))
}

pub fn strip_codes(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut it = line.chars().peekable();
    while let Some(c) = it.next() {
        if c == '^' && it.peek().map(|n| n.is_ascii_alphanumeric()).unwrap_or(false) {
            it.next();
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Incremental reader for the engine's console log.
pub struct LogTail {
    path: PathBuf,
    offset: u64,
    partial: String,
}

impl LogTail {
    pub fn new(home: &str) -> Self {
        LogTail { path: game_home(home).join("qconsole.log"), offset: 0, partial: String::new() }
    }

    /// Returns the complete lines appended since the last call.
    pub fn poll(&mut self) -> Vec<String> {
        let Ok(mut f) = std::fs::File::open(&self.path) else { return Vec::new() };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            self.offset = 0; // log was recreated
            self.partial.clear();
        }
        if len == self.offset || f.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::new();
        if f.take(4 * 1024 * 1024).read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.offset += buf.len() as u64;
        self.partial.push_str(&String::from_utf8_lossy(&buf));
        let mut lines: Vec<String> = Vec::new();
        while let Some(i) = self.partial.find('\n') {
            let line = strip_codes(&self.partial[..i]);
            self.partial.drain(..=i);
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        lines
    }
}

/// Builds cmd.cfg: one guarded entry per recent batch, oldest first.
pub fn command_index(latest: u64) -> String {
    let first = latest.saturating_sub(BATCH_WINDOW - 1).max(1);
    let mut s = String::new();
    for n in first..=latest {
        let slot = n % BATCH_WINDOW;
        s.push_str(&format!("set wd_b{slot} \"set wd_seq {n}; execq {DECK_DIR}/b{slot}.cfg\"\niflt wd_seq {n} wd_b{slot}\n"));
    }
    s
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // The engine may have the target open for a moment; retry briefly.
    for _ in 0..20 {
        if std::fs::rename(&tmp, path).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    std::fs::write(path, text).map_err(|e| e.to_string())
}

struct Running {
    child: Child,
    home: String,
    control_key: String,
    seq: u64,
    stop: Arc<AtomicBool>,
}

/// The one WolfcamQL process WolfDeck is driving interactively.
#[derive(Default)]
pub struct Session {
    inner: Mutex<Option<Running>>,
}

impl Session {
    pub fn is_running(&self) -> bool {
        let mut g = self.inner.lock().unwrap();
        match g.as_mut() {
            Some(r) => matches!(r.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn launch(self: &Arc<Self>, spec: LaunchSpec, sink: Arc<dyn Sink>) -> Result<u32, String> {
        self.stop();
        let child = spawn(&spec)?;
        let pid = child.id();
        let stop = Arc::new(AtomicBool::new(false));
        *self.inner.lock().unwrap() =
            Some(Running { child, home: spec.home.clone(), control_key: spec.control_key.clone(), seq: 0, stop: stop.clone() });
        sink.emit("wolfcam-state", json!({ "running": true, "ready": false, "pid": pid, "demo": spec.demo }));

        let this = self.clone();
        std::thread::spawn(move || {
            let mut tail = LogTail::new(&spec.home);
            let mut ready = false;
            loop {
                std::thread::sleep(Duration::from_millis(150));
                let lines = tail.poll();
                if !ready && lines.iter().any(|l| l.starts_with("WD_READY")) {
                    ready = true;
                    sink.emit("wolfcam-state", json!({ "running": true, "ready": true, "pid": pid, "demo": spec.demo }));
                }
                publish_lines(&*sink, lines);
                if stop.load(Ordering::Relaxed) {
                    return; // replaced or stopped; whoever did that reports the state
                }
                let exited = {
                    let mut g = this.inner.lock().unwrap();
                    match g.as_mut() {
                        Some(r) if r.child.id() == pid => match r.child.try_wait() {
                            Ok(None) => None,
                            Ok(Some(st)) => Some(st.code()),
                            Err(_) => Some(None),
                        },
                        _ => return,
                    }
                };
                if let Some(code) = exited {
                    publish_lines(&*sink, tail.poll());
                    let mut g = this.inner.lock().unwrap();
                    if g.as_ref().map(|r| r.child.id() == pid).unwrap_or(false) {
                        *g = None;
                    }
                    sink.emit("wolfcam-state", json!({ "running": false, "exitCode": code }));
                    return;
                }
            }
        });
        Ok(pid)
    }

    /// Queues console commands for execution in the running engine.
    pub fn send(&self, commands: &[String]) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        let r = g.as_mut().ok_or("WolfcamQL is not running")?;
        if !matches!(r.child.try_wait(), Ok(None)) {
            return Err("WolfcamQL is not running".into());
        }
        let body: String = commands
            .iter()
            .map(|c| c.replace(['\n', '\r'], " "))
            .filter(|c| !c.trim().is_empty())
            .map(|c| c + "\n")
            .collect();
        if body.is_empty() {
            return Ok(());
        }
        let dir = deck_dir(&r.home);
        r.seq += 1;
        write_atomic(&dir.join(format!("b{}.cfg", r.seq % BATCH_WINDOW)), &body)?;
        write_atomic(&dir.join("cmd.cfg"), &command_index(r.seq))?;
        trigger(r.child.id(), &r.home, &r.control_key)
    }

    /// Asks the engine to quit, then makes sure the process is gone.
    pub fn stop(&self) {
        let _ = self.send(&["quit".to_string()]);
        let taken = self.inner.lock().unwrap().take();
        if let Some(mut r) = taken {
            r.stop.store(true, Ordering::Relaxed);
            for _ in 0..20 {
                if !matches!(r.child.try_wait(), Ok(None)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

fn publish_lines(sink: &dyn Sink, mut lines: Vec<String>) {
    if lines.is_empty() {
        return;
    }
    for l in &lines {
        // Printed by the engine's `servertime` command.
        if let Some(v) = l.strip_prefix("serverTime:").and_then(|v| v.trim().parse::<f64>().ok()) {
            sink.emit("wolfcam-time", json!({ "serverTime": v }));
        }
    }
    // The UI console only needs the gist when the engine floods its log.
    const KEEP: usize = 600;
    if lines.len() > KEEP {
        let dropped = lines.len() - KEEP;
        lines.drain(KEEP / 2..KEEP / 2 + dropped);
        lines.insert(KEEP / 2, format!("... {dropped} lines skipped ..."));
    }
    sink.emit("wolfcam-log", json!(lines));
}

/// Tells the engine to execute cmd.cfg now.
#[cfg(unix)]
pub fn trigger(_pid: u32, home: &str, _control_key: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
    let pipe = game_home(home).join(PIPE_NAME);
    let is_fifo = std::fs::metadata(&pipe).map(|m| m.file_type().is_fifo()).unwrap_or(false);
    if !is_fifo {
        return Err("WolfcamQL is still starting (command pipe not ready)".into());
    }
    // O_NONBLOCK: never hang if the engine is not reading (0o4000 on Linux, 0x4 on macOS/BSD).
    let nonblock = if cfg!(target_os = "linux") { 0o4000 } else { 0x4 };
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(nonblock)
        .open(&pipe)
        .map_err(|_| "WolfcamQL is still starting (command pipe not ready)".to_string())?;
    f.write_all(format!("execq {DECK_DIR}/cmd.cfg\n").as_bytes()).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn key_codes(name: &str) -> (u32, u32) {
    // (virtual key, scan code) for F1..F15; anything else falls back to F13.
    let n: u32 = name.trim().trim_start_matches(['F', 'f']).parse().unwrap_or(13);
    let n = if (1..=15).contains(&n) { n } else { 13 };
    let scan = match n {
        1..=10 => 0x3B + n - 1,
        11 => 0x57,
        12 => 0x58,
        _ => 0x64 + n - 13,
    };
    (0x70 + n - 1, scan)
}

#[cfg(windows)]
pub fn trigger(pid: u32, _home: &str, control_key: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_KEYDOWN, WM_KEYUP,
    };
    struct Find {
        pid: u32,
        hwnd: HWND,
    }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let find = &mut *(lparam as *mut Find);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == find.pid && IsWindowVisible(hwnd) != 0 {
            find.hwnd = hwnd;
            return 0;
        }
        1
    }
    let mut find = Find { pid, hwnd: std::ptr::null_mut() };
    unsafe { EnumWindows(Some(each), &mut find as *mut Find as LPARAM) };
    if find.hwnd.is_null() {
        return Err("WolfcamQL window not found yet".into());
    }
    let (vk, scan) = key_codes(control_key);
    let down = (1 | (scan << 16)) as LPARAM;
    let up = (1u32 | (scan << 16) | (1 << 30) | (1 << 31)) as i32 as LPARAM;
    unsafe {
        PostMessageW(find.hwnd, WM_KEYDOWN, vk as usize, down);
        PostMessageW(find.hwnd, WM_KEYUP, vk as usize, up);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_is_built_in_engine_order() {
        let home = std::env::temp_dir().join(format!("wolfdeck-args-{}", std::process::id()));
        std::fs::create_dir_all(home.join(GAME_DIR)).unwrap();
        let mut spec = LaunchSpec {
            exe: "/opt/wc/wolfcamql".into(),
            home: home.to_string_lossy().into_owned(),
            cvars: vec![("r_mode".into(), "-1".into()), ("cg_fov".into(), "100".into())],
            demo: Some("/demos/a+b.dm_91".into()),
            ..Default::default()
        };
        let a = build_args(&spec).unwrap();
        assert_eq!(&a[..3], ["+set", "fs_homepath", spec.home.as_str()]);
        let at = |x: &str| a.iter().position(|y| y == x).unwrap_or_else(|| panic!("missing {x} in {a:?}"));
        assert!(at("wolfdeck/pre.cfg") < at("+vid_restart") && at("+vid_restart") < at("+demo"));
        assert_eq!(a[at("+demo") + 1], "\"/demos/a+b.dm_91\"", "'+' must be quoted for the engine");
        assert_eq!(a[a.len() - 2..], ["+exec", "wolfdeck/session.cfg"]);
        assert!(!a.iter().any(|x| x == "r_mode"), "cvars travel in pre.cfg, not on the command line");

        // No restart once the saved engine config already has the latched values.
        std::fs::write(home.join(GAME_DIR).join("q3config.cfg"), "seta r_mode \"-1\"\nseta cg_fov \"90\"\n").unwrap();
        assert!(!build_args(&spec).unwrap().contains(&"+vid_restart".to_string()));
        spec.cvars.push(("r_picmip".into(), "0".into()));
        assert!(build_args(&spec).unwrap().contains(&"+vid_restart".to_string()));
        assert!(is_latched("R_PicMip") && is_latched("s_useOpenAL") && is_latched("r_someNewThing"));
        assert!(!is_latched("r_gamma") && !is_latched("r_fullscreen") && !is_latched("s_volume") && !is_latched("cg_fov"));

        prepare_files(&spec).unwrap();
        let pre = std::fs::read_to_string(home.join(GAME_DIR).join("wolfdeck/pre.cfg")).unwrap();
        assert!(pre.contains("set r_mode \"-1\"\nset cg_fov \"100\"\nset r_picmip \"0\"\n"));

        spec.demo = Some(format!("/{}.dm_91", "x".repeat(1100)));
        assert!(build_args(&spec).is_err(), "over-long command lines are refused instead of crashing the engine");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cvar_tokens_cannot_inject_commands() {
        assert_eq!(clean_token("1\"; quit"), "1 quit");
        assert_eq!(clean_token("bad;name\n"), "badname");
    }

    #[test]
    fn command_index_keeps_a_sliding_window() {
        let one = command_index(1);
        assert_eq!(one, "set wd_b1 \"set wd_seq 1; execq wolfdeck/b1.cfg\"\niflt wd_seq 1 wd_b1\n");
        let many = command_index(200);
        assert!(many.starts_with("set wd_b9 \"set wd_seq 137; execq wolfdeck/b9.cfg\""), "oldest listed batch is 137, slot 137 % 64");
        assert_eq!(many.matches("iflt").count(), 64);
        assert!(many.trim_end().ends_with("iflt wd_seq 200 wd_b8"));
    }

    #[test]
    fn log_tail_returns_only_new_complete_lines() {
        let home = std::env::temp_dir().join(format!("wolfdeck-tail-{}", std::process::id()));
        let game = home.join(GAME_DIR);
        std::fs::create_dir_all(&game).unwrap();
        let log = game.join("qconsole.log");
        std::fs::write(&log, "^1first^7 line\nsecond").unwrap();
        let mut t = LogTail::new(&home.to_string_lossy());
        assert_eq!(t.poll(), vec!["first line"]);
        assert!(t.poll().is_empty());
        std::fs::write(&log, "^1first^7 line\nsecond half\nserverTime: 1234\n").unwrap();
        assert_eq!(t.poll(), vec!["second half", "serverTime: 1234"]);
        std::fs::write(&log, "new\n").unwrap();
        assert_eq!(t.poll(), vec!["new"], "a recreated log is read from the start");
        let _ = std::fs::remove_dir_all(&home);
    }
}
