//! Starting WolfcamQL.
//!
//! Wolfcam Wrapper only starts the engine; it does not control it while it runs.
//! The command line stays minimal (the engine caps it at 1023 characters and
//! 32 commands). Cvars go into `wolfcam-wrapper/pre.cfg`, executed before the demo
//! loads, and everything else into `wolfcam-wrapper/start.cfg`, which
//! `wolfcam-wrapper/session.cfg` runs once the demo has loaded. Renders follow the
//! engine's progress through its console log (`logfile 2`), read with
//! [`LogTail`].

use crate::paths::{resolve_home, WRAPPER_DIR, GAME_DIR};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    /// Folders put in front of PATH for the engine, e.g. where ffmpeg lives
    /// when WolfcamQL pipes video into it.
    pub path_prepend: Vec<String>,
}

pub fn game_home(home: &str) -> PathBuf {
    resolve_home(home).join(GAME_DIR)
}

pub fn wrapper_dir(home: &str) -> PathBuf {
    game_home(home).join(WRAPPER_DIR)
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
    a.extend(["+set".into(), "logfile".into(), "2".into()]);
    a.extend(spec.extra_args.iter().filter(|s| !s.trim().is_empty()).cloned());
    if spec.cvars.iter().any(|(k, _)| !clean_token(k).is_empty()) {
        a.extend(["+exec".into(), format!("{WRAPPER_DIR}/pre.cfg")]);
        if needs_video_restart(spec) {
            a.push("+vid_restart".into());
        }
    }
    if let Some(demo) = spec.demo.as_ref().filter(|d| !d.is_empty()) {
        a.extend(["+demo".into(), engine_arg(demo)]);
    }
    a.extend(["+exec".into(), format!("{WRAPPER_DIR}/session.cfg")]);
    // Engine limits: 1023 characters in total (it aborts beyond that) and 32 '+' commands.
    let length: usize = a.iter().map(|s| s.len() + 3).sum();
    let commands = a.iter().filter(|s| s.starts_with('+')).count();
    if length > 1000 || commands > 30 {
        return Err("The WolfcamQL command line would be too long. Shorten the extra arguments or move the demo to a shorter path.".into());
    }
    Ok(a)
}

fn start_script() -> String {
    format!("// Generated by Wolfcam Wrapper.\nexec {WRAPPER_DIR}/start.cfg\n")
}

/// `session.cfg` runs straight after `+demo`, but the demo is not always loaded by then: for
/// protocol 91 demos (Steam-era Quake Live) WolfcamQL first checks, and may download, the demo's
/// Steam Workshop items over the following frames. Commands run during that wait are lost or
/// misapplied (a seek is undone, `follow` and `at` do not exist yet). So wait, a few frames at a
/// time, until WolfcamQL clears `r_uiFullScreen`, which it does right before loading the game code
/// for playback; then run the session's commands.
fn wait_for_demo_script() -> String {
    format!(
        "// Generated by Wolfcam Wrapper: waits for the demo to load, then runs start.cfg.\n\
         set wcw_start \"exec {WRAPPER_DIR}/start.cfg\"\n\
         set wcw_wait \"wait 5; vstr wcw_poll\"\n\
         set wcw_poll \"ifeq r_uiFullScreen 0 wcw_start wcw_wait\"\n\
         vstr wcw_poll\n"
    )
}

/// Writes the generated config files and removes leftovers of older sessions.
pub fn prepare_files(spec: &LaunchSpec) -> Result<PathBuf, String> {
    let dir = wrapper_dir(&spec.home);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let mut start = String::from("// Generated by Wolfcam Wrapper: the session's commands, run once the demo has loaded.\n");
    start.push_str(&spec.config);
    start.push('\n');
    start.push_str("echo WCW_READY\n");
    let session = if spec.demo.as_deref().is_some_and(|d| !d.is_empty()) { wait_for_demo_script() } else { start_script() };
    let mut pre = String::from("// Generated by Wolfcam Wrapper: settings applied before the demo loads.\n");
    for (k, v) in &spec.cvars {
        let (k, v) = (clean_token(k), clean_token(v));
        if !k.is_empty() {
            pre.push_str(&format!("set {k} \"{v}\"\n"));
        }
    }
    std::fs::write(dir.join("pre.cfg"), pre).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("start.cfg"), start).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("session.cfg"), session).map_err(|e| e.to_string())?;
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
    if !spec.path_prepend.is_empty() {
        let mut dirs: Vec<PathBuf> = spec.path_prepend.iter().map(PathBuf::from).collect();
        if let Some(p) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&p));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
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

struct Running {
    child: Child,
    started: Instant,
}

/// The WolfcamQL process started to watch a demo. Starting another demo
/// replaces it; nothing is sent to it while it runs.
#[derive(Default)]
pub struct Session {
    inner: Mutex<Option<Running>>,
}

/// A process that ends this soon after starting most likely failed to load the demo.
const EARLY_EXIT: Duration = Duration::from_secs(20);

impl Session {
    pub fn is_running(&self) -> bool {
        let mut g = self.inner.lock().unwrap();
        g.as_mut().map(|r| matches!(r.child.try_wait(), Ok(None))).unwrap_or(false)
    }

    pub fn launch(self: &Arc<Self>, spec: LaunchSpec, sink: Arc<dyn Sink>) -> Result<u32, String> {
        self.stop();
        let child = spawn(&spec)?;
        let pid = child.id();
        *self.inner.lock().unwrap() = Some(Running { child, started: Instant::now() });
        sink.emit("wolfcam-state", json!({ "running": true, "pid": pid, "demo": spec.demo }));
        let this = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut g = this.inner.lock().unwrap();
            let Some(r) = g.as_mut().filter(|r| r.child.id() == pid) else { return }; // replaced or stopped
            let code = match r.child.try_wait() {
                Ok(None) => continue,
                Ok(Some(st)) => st.code(),
                Err(_) => None,
            };
            let early = r.started.elapsed() < EARLY_EXIT && code != Some(0);
            *g = None;
            sink.emit("wolfcam-state", json!({ "running": false, "exitCode": code, "early": early }));
            return;
        });
        Ok(pid)
    }

    /// Closes the engine Wolfcam Wrapper started, if it is still open.
    pub fn stop(&self) {
        if let Some(mut r) = self.inner.lock().unwrap().take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_is_built_in_engine_order() {
        let home = std::env::temp_dir().join(format!("wolfcam-wrapper-args-{}", std::process::id()));
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
        assert!(at("wolfcam-wrapper/pre.cfg") < at("+vid_restart") && at("+vid_restart") < at("+demo"));
        assert_eq!(a[at("+demo") + 1], "\"/demos/a+b.dm_91\"", "'+' must be quoted for the engine");
        assert_eq!(a[a.len() - 2..], ["+exec", "wolfcam-wrapper/session.cfg"]);
        assert!(!a.iter().any(|x| x == "r_mode"), "cvars travel in pre.cfg, not on the command line");

        // No restart once the saved engine config already has the latched values.
        std::fs::write(home.join(GAME_DIR).join("q3config.cfg"), "seta r_mode \"-1\"\nseta cg_fov \"90\"\n").unwrap();
        assert!(!build_args(&spec).unwrap().contains(&"+vid_restart".to_string()));
        spec.cvars.push(("r_picmip".into(), "0".into()));
        assert!(build_args(&spec).unwrap().contains(&"+vid_restart".to_string()));
        assert!(is_latched("R_PicMip") && is_latched("s_useOpenAL") && is_latched("r_someNewThing"));
        assert!(!is_latched("r_gamma") && !is_latched("r_fullscreen") && !is_latched("s_volume") && !is_latched("cg_fov"));

        prepare_files(&spec).unwrap();
        let pre = std::fs::read_to_string(home.join(GAME_DIR).join("wolfcam-wrapper/pre.cfg")).unwrap();
        assert!(pre.contains("set r_mode \"-1\"\nset cg_fov \"100\"\nset r_picmip \"0\"\n"));
        // With a demo, session.cfg waits for it to load before running start.cfg (the session's commands).
        let read = |f: &str| std::fs::read_to_string(home.join(GAME_DIR).join("wolfcam-wrapper").join(f)).unwrap();
        spec.config = "seekservertime 5000\n".into();
        prepare_files(&spec).unwrap();
        assert!(read("session.cfg").contains("ifeq r_uiFullScreen 0 wcw_start wcw_wait") && read("session.cfg").contains("exec wolfcam-wrapper/start.cfg"));
        assert!(read("start.cfg").contains("seekservertime 5000\n") && read("start.cfg").trim_end().ends_with("echo WCW_READY"));
        assert!(!a.iter().any(|x| x == "com_pipefile"), "nothing is sent to the engine while it runs");
        spec.demo = None;
        prepare_files(&spec).unwrap();
        assert!(!read("session.cfg").contains("ifeq"), "nothing to wait for without a demo");
        spec.demo = Some("/demos/a+b.dm_91".into());

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
    fn log_tail_returns_only_new_complete_lines() {
        let home = std::env::temp_dir().join(format!("wolfcam-wrapper-tail-{}", std::process::id()));
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
