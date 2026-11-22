//! End-to-end checks against a real WolfcamQL binary. They are skipped
//! unless these environment variables are set:
//!
//! * `WOLFCAM_WRAPPER_TEST_WOLFCAM`  path to the WolfcamQL executable
//! * `WOLFCAM_WRAPPER_TEST_DEMO`     demo to play
//! * `WOLFCAM_WRAPPER_TEST_HOME`     scratch directory used as fs_homepath
//! * `WOLFCAM_WRAPPER_TEST_ARGS`     extra engine arguments (optional), e.g.
//!   "+set r_forceMap oa_dm1 +set s_useOpenAL 0"
//!
//! Run with: `cargo test --test engine -- --nocapture --test-threads 1`

use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wolfcam_wrapper_lib::render::{run_queue, EncodeSpec, RenderBase, RenderJob};
use wolfcam_wrapper_lib::session::{LaunchSpec, Session, Sink};

#[derive(Default)]
struct Collect(Mutex<Vec<(String, Value)>>);

impl Sink for Collect {
    fn emit(&self, event: &str, payload: Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

impl Collect {
    fn last_state(&self) -> Option<Value> {
        self.0.lock().unwrap().iter().rev().find(|(e, _)| e == "wolfcam-state").map(|(_, p)| p.clone())
    }
}

fn log_text(home: &str) -> String {
    String::from_utf8_lossy(&std::fs::read(std::path::Path::new(home).join("wolfcam-ql/qconsole.log")).unwrap_or_default()).into_owned()
}

/// Server times printed by the engine's `servertime` command.
fn logged_times(home: &str) -> Vec<f64> {
    log_text(home).lines().filter_map(|l| l.trim().strip_prefix("serverTime:")).filter_map(|v| v.trim().parse().ok()).collect()
}

/// Number of console log lines that are exactly `needle`.
fn log_count(home: &str, needle: &str) -> usize {
    let log = std::path::Path::new(home).join("wolfcam-ql/qconsole.log");
    String::from_utf8_lossy(&std::fs::read(log).unwrap_or_default()).lines().filter(|l| l.trim() == needle).count()
}

struct Env {
    exe: String,
    demo: String,
    home: String,
    args: Vec<String>,
}

fn env() -> Option<Env> {
    let exe = std::env::var("WOLFCAM_WRAPPER_TEST_WOLFCAM").ok()?;
    Some(Env {
        exe,
        demo: std::env::var("WOLFCAM_WRAPPER_TEST_DEMO").ok()?,
        home: std::env::var("WOLFCAM_WRAPPER_TEST_HOME").ok()?,
        args: std::env::var("WOLFCAM_WRAPPER_TEST_ARGS").unwrap_or_default().split_whitespace().map(String::from).collect(),
    })
}

fn wait_for(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let t = Instant::now();
    while !ok() {
        assert!(t.elapsed() < Duration::from_secs(secs), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn small_window() -> Vec<(String, String)> {
    [("r_fullscreen", "0"), ("r_mode", "-1"), ("r_customwidth", "320"), ("r_customheight", "180"), ("com_logo", "0")]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn render_queue_captures_and_encodes_a_clip() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFCAM_WRAPPER_TEST_* not set");
        return;
    };
    let info = wolfcam_wrapper_lib::demo::parse_file(std::path::Path::new(&e.demo)).unwrap();
    let start = info.game_start_time.unwrap_or(info.first_server_time) + 10_000;
    let out_dir = std::path::Path::new(&e.home).join("encoded");
    let mut cvars = small_window();
    cvars.push(("cl_aviFrameRate".into(), "30".into()));
    cvars.push(("cl_aviCodec".into(), "mjpeg".into()));
    let job = RenderJob {
        id: "job1".into(),
        demo: e.demo.clone(),
        name: "wolfcam-wrapper test clip".into(),
        start_time: start,
        end_time: start + 2000,
        pov: None,
        pre_roll_ms: 1000,
        cvars,
        config: String::new(),
        video_args: "avi".into(),
        encode: Some(EncodeSpec {
            ffmpeg: "ffmpeg".into(),
            args: "-c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac".split(' ').map(String::from).collect(),
            extension: "mp4".into(),
            output_dir: out_dir.to_string_lossy().into_owned(),
            delete_source: true,
        }),
        speed: 1.0,
        pipe: None,
    };
    // Second clip: lossless codec, engine motion blur, sound in a separate WAV, another POV.
    let mut blur = job.clone();
    blur.id = "job2".into();
    blur.name = "wolfcam-wrapper blur clip".into();
    blur.pov = info.kills.iter().find(|k| !k.own_goal).map(|k| k.killer);
    blur.video_args = "avins wav".into();
    blur.cvars.retain(|(k, _)| k != "cl_aviCodec");
    blur.cvars.push(("cl_aviCodec".into(), "huffyuv".into()));
    blur.cvars.push(("mme_blurFrames".into(), "4".into()));
    if let Some(enc) = blur.encode.as_mut() {
        enc.delete_source = false;
    }

    let sink = Arc::new(Collect::default());
    let base = RenderBase { exe: e.exe, home: e.home.clone(), extra_args: e.args };
    run_queue(vec![job, blur], base, sink.clone(), Arc::new(AtomicBool::new(false)));

    let events = sink.0.lock().unwrap();
    let final_of = |id: &str| events.iter().rev().find(|(ev, p)| ev == "render-update" && p["id"] == id).map(|(_, p)| p.clone()).unwrap();
    let last = final_of("job1");
    assert_eq!(last["status"], "done", "render failed: {last}");
    let second = final_of("job2");
    assert_eq!(second["status"], "done", "blur render failed: {second}");
    let blur_mp4 = out_dir.join("wolfcam-wrapper_blur_clip.mp4");
    let streams = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
        .arg(&blur_mp4)
        .output()
        .unwrap();
    let streams = String::from_utf8_lossy(&streams.stdout);
    assert!(streams.contains("video") && streams.contains("audio"), "separate WAV must be muxed in: {streams}");
    assert!(std::path::Path::new(&e.home).join("wolfcam-ql/videos/wolfcam-wrapper_blur_clip.avi").exists(), "source kept when asked");
    assert!(events.iter().any(|(ev, p)| ev == "render-update" && p["status"] == "capturing" && p["progress"].as_f64().unwrap_or(0.0) >= 0.5));
    assert!(events.iter().any(|(ev, _)| ev == "render-finished"));
    let mp4 = out_dir.join("wolfcam-wrapper_test_clip.mp4");
    assert_eq!(last["outputs"][0], mp4.to_string_lossy().as_ref());
    assert!(mp4.metadata().unwrap().len() > 10_000);

    // Two seconds at 30 fps, give or take a frame; and the AVI source was removed.
    let probe = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height", "-of", "csv=p=0"])
        .arg(&mp4)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&probe.stdout).trim().to_string();
    let parts: Vec<i64> = text.split(',').filter_map(|p| p.parse().ok()).collect();
    assert_eq!(&parts[..2], [320, 180], "ffprobe: {text}");
    assert!((58..=62).contains(&parts[2]), "expected ~60 frames, got {text}");
    assert!(!std::path::Path::new(&e.home).join("wolfcam-ql/videos/wolfcam-wrapper_test_clip.avi").exists());
}

/// Key binds from the Keys view are applied when a demo is opened: WolfcamQL's
/// own binds are cleared, the map's binds work for real key presses, and the
/// engine's saved config reads back the same map for "Import from WolfcamQL".
#[test]
fn key_binds_apply_at_launch() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFCAM_WRAPPER_TEST_* not set");
        return;
    };
    let session = Arc::new(Session::default());
    // What the UI generates for a key map: clear everything, then bind. The reports and the
    // config write after it are only for this test.
    let config = "unbindall\nbind SPACE \"echo WCW_SPACE_PRESSED\"\nbind u \"selectcamerapoint last; deletecamerapoint\"\nbind MWHEELUP \"fastforward 1\"\n\
                  bind SPACE\nbind u\nbind ENTER\nwriteconfig q3config.cfg\n";
    let mut cvars = small_window();
    cvars.push(("in_nograb".into(), "1".into()));
    let spec = LaunchSpec { exe: e.exe.clone(), home: e.home.clone(), cvars, demo: Some(e.demo.clone()), config: config.into(), extra_args: e.args.clone(), path_prepend: Vec::new() };
    session.launch(spec, Arc::new(Collect::default())).unwrap();
    wait_for("engine ready", 60, || log_count(&e.home, "WCW_READY") > 0);
    let log = log_text(&e.home);
    assert!(log.contains("\"u\" = \"selectcamerapoint last; deletecamerapoint\""), "bind reports missing");
    assert!(log.contains("\"SPACE\" = \"echo WCW_SPACE_PRESSED\""));
    assert!(log.contains("\"ENTER\" is not bound"), "unbindall must have removed WolfcamQL's default bind");

    // A real key press runs the bind.
    let xdotool = std::process::Command::new("sh")
        .args(["-c", "w=$(xdotool search --name 'wolfcam' | head -1) && xdotool windowfocus $w && sleep 0.3 && xdotool key space"])
        .status();
    if xdotool.map(|s| s.success()).unwrap_or(false) {
        wait_for("bound key press", 10, || log_count(&e.home, "WCW_SPACE_PRESSED") > 0);
    } else {
        eprintln!("xdotool not available: skipped the real key press");
    }

    let saved = wolfcam_wrapper_lib::paths::read_binds(&e.home).unwrap();
    assert!(saved.contains(&("SPACE".to_string(), "echo WCW_SPACE_PRESSED".to_string())), "{saved:?}");
    assert!(saved.contains(&("MWHEELUP".to_string(), "fastforward 1".to_string())), "{saved:?}");
    assert_eq!(saved.len(), 3, "{saved:?}");
    session.stop();
    assert!(!session.is_running());
}

fn probe(file: &std::path::Path) -> (String, i64) {
    // (stream types, video frame count)
    let types = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
        .arg(file)
        .output()
        .unwrap();
    let frames = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"])
        .arg(file)
        .output()
        .unwrap();
    (
        String::from_utf8_lossy(&types.stdout).split_whitespace().collect::<Vec<_>>().join(","),
        String::from_utf8_lossy(&frames.stdout).trim().parse().unwrap_or(-1),
    )
}

/// Slow motion, encoding while recording (ffmpeg pipe), and a clip that runs
/// past the end of the demo (clamped instead of hanging).
#[test]
fn render_slow_motion_pipe_and_demo_end() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFCAM_WRAPPER_TEST_* not set");
        return;
    };
    let info = wolfcam_wrapper_lib::demo::parse_file(std::path::Path::new(&e.demo)).unwrap();
    let start = info.game_start_time.unwrap_or(info.first_server_time) + 20_000;
    let out_dir = std::path::Path::new(&e.home).join("piped");
    let mut cvars = small_window();
    cvars.push(("cl_aviFrameRate".into(), "30".into()));
    cvars.push(("cl_aviCodec".into(), "mjpeg".into()));
    let enc = EncodeSpec {
        ffmpeg: "/usr/bin/ffmpeg".into(),
        args: "-c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac".split(' ').map(String::from).collect(),
        extension: "mp4".into(),
        output_dir: out_dir.to_string_lossy().into_owned(),
        delete_source: true,
    };
    let base_job = RenderJob {
        demo: e.demo.clone(),
        pre_roll_ms: 500,
        cvars,
        video_args: "avi".into(),
        ..Default::default()
    };
    let slow = RenderJob { id: "slow".into(), name: "wcw slow".into(), start_time: start, end_time: start + 2000, speed: 0.5, pipe: Some(enc.clone()), ..base_job.clone() };
    let late = RenderJob {
        id: "late".into(),
        name: "wcw late".into(),
        start_time: info.last_server_time - 2000,
        end_time: info.last_server_time + 30_000,
        encode: Some(enc),
        ..base_job
    };
    let sink = Arc::new(Collect::default());
    let base = RenderBase { exe: e.exe, home: e.home.clone(), extra_args: e.args };
    let t = Instant::now();
    run_queue(vec![slow, late], base, sink.clone(), Arc::new(AtomicBool::new(false)));
    assert!(t.elapsed() < Duration::from_secs(150), "render took {:?}", t.elapsed());

    let events = sink.0.lock().unwrap();
    let final_of = |id: &str| events.iter().rev().find(|(ev, p)| ev == "render-update" && p["id"] == id).map(|(_, p)| p.clone()).unwrap();
    let slow_done = final_of("slow");
    assert_eq!(slow_done["status"], "done", "{slow_done}");
    let mp4 = out_dir.join("wcw_slow.mp4");
    assert_eq!(slow_done["outputs"][0], mp4.to_string_lossy().as_ref());
    let (types, frames) = probe(&mp4);
    assert_eq!(types, "video,audio", "piped encode keeps the sound");
    assert!((115..=125).contains(&frames), "2 s of demo at half speed and 30 fps is ~120 frames, got {frames}");
    let videos = std::path::Path::new(&e.home).join("wolfcam-ql/videos");
    assert!(!videos.join("wcw_slow.avi").exists(), "nothing is written to disk before encoding");

    let late_done = final_of("late");
    assert_eq!(late_done["status"], "done", "a clip past the end must be shortened, not hang: {late_done}");
    let (_, late_frames) = probe(&out_dir.join("wcw_late.mp4"));
    assert!((45..=56).contains(&late_frames), "clamped to ~1.7 s, got {late_frames} frames");
}

/// Opening a frag from the highlights: the demo starts at the requested time,
/// follows the requested player, and loads the profile's HUD. With a
/// protocol 91 demo this covers WolfcamQL's Steam Workshop check, which delays
/// loading past `+demo`.
#[test]
fn launch_starts_at_requested_time() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFCAM_WRAPPER_TEST_* not set");
        return;
    };
    let info = wolfcam_wrapper_lib::demo::parse_file(std::path::Path::new(&e.demo)).unwrap();
    let kill = info.kills.iter().rfind(|k| !k.own_goal).expect("demo has kills");
    let target = kill.server_time - 3000;
    // A custom HUD chosen in the Config view: installed, then named in cg_hudFiles.
    let hud_src = std::path::Path::new(&e.home).join("wcwtest.menu");
    std::fs::write(&hud_src, "menuDef {\n\tname \"wcwtest\"\n\tfullScreen 0\n\tvisible 1\n\trect 0 0 640 480\n}\n").unwrap();
    let hud = wolfcam_wrapper_lib::paths::install_hud(&e.exe, &e.home, &hud_src.to_string_lossy()).unwrap();
    let mut cvars = small_window();
    cvars.push(("cg_hudFiles".into(), hud.clone()));
    // What the UI sends, plus reports for the test once playback has run for a second.
    let config = format!(
        "{}\nseekservertime {target}\nat {} servertime\nat {} follow\n",
        wolfcam_wrapper_lib::render::follow_line(kill.killer),
        target + 1000,
        target + 1000
    );
    let sink = Arc::new(Collect::default());
    let session = Arc::new(Session::default());
    let spec = LaunchSpec { exe: e.exe.clone(), home: e.home.clone(), cvars, demo: Some(e.demo.clone()), config, extra_args: e.args.clone(), path_prepend: Vec::new() };
    session.launch(spec, sink.clone()).unwrap();
    wait_for("server time report", 60, || !logged_times(&e.home).is_empty());
    let got = logged_times(&e.home)[0];
    eprintln!("first server time {}, target {target}, engine at {got}", info.first_server_time);
    assert!(got >= target as f64 && got < target as f64 + 3000.0, "started at {got}, wanted {target}");
    let following = format!("currently following [{}]", kill.killer);
    wait_for("follow report", 20, || log_text(&e.home).contains(&following));
    let loaded = log_text(&e.home).lines().find(|l| l.contains("CG_LoadMenus()")).unwrap_or_default().to_string();
    assert!(loaded.contains(&hud), "the profile's HUD must be the one loaded at start, got: {loaded}");

    // Closing it from Wolfcam Wrapper ends the process and reports that.
    assert!(session.is_running());
    session.stop();
    assert!(!session.is_running());
    let _ = sink.last_state();
}
