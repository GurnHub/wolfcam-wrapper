//! End-to-end checks against a real WolfcamQL binary. They are skipped
//! unless these environment variables are set:
//!
//! * `WOLFDECK_TEST_WOLFCAM`  path to the WolfcamQL executable
//! * `WOLFDECK_TEST_DEMO`     demo to play
//! * `WOLFDECK_TEST_HOME`     scratch directory used as fs_homepath
//! * `WOLFDECK_TEST_ARGS`     extra engine arguments (optional), e.g.
//!   "+set r_forceMap oa_dm1 +set s_useOpenAL 0"
//!
//! Run with: `cargo test --test engine -- --nocapture --test-threads 1`

use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wolfdeck_lib::render::{run_queue, EncodeSpec, RenderBase, RenderJob};
use wolfdeck_lib::session::{LaunchSpec, Session, Sink};

#[derive(Default)]
struct Collect(Mutex<Vec<(String, Value)>>);

impl Sink for Collect {
    fn emit(&self, event: &str, payload: Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

impl Collect {
    fn times(&self) -> Vec<f64> {
        self.0.lock().unwrap().iter().filter(|(e, _)| e == "wolfcam-time").filter_map(|(_, p)| p["serverTime"].as_f64()).collect()
    }
    fn ready(&self) -> bool {
        self.0.lock().unwrap().iter().any(|(e, p)| e == "wolfcam-state" && p["ready"] == true)
    }
    fn last_state(&self) -> Option<Value> {
        self.0.lock().unwrap().iter().rev().find(|(e, _)| e == "wolfcam-state").map(|(_, p)| p.clone())
    }
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
    let exe = std::env::var("WOLFDECK_TEST_WOLFCAM").ok()?;
    Some(Env {
        exe,
        demo: std::env::var("WOLFDECK_TEST_DEMO").ok()?,
        home: std::env::var("WOLFDECK_TEST_HOME").ok()?,
        args: std::env::var("WOLFDECK_TEST_ARGS").unwrap_or_default().split_whitespace().map(String::from).collect(),
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
fn live_session_executes_each_command_batch_once() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFDECK_TEST_* not set");
        return;
    };
    let info = wolfdeck_lib::demo::parse_file(std::path::Path::new(&e.demo)).unwrap();
    let sink = Arc::new(Collect::default());
    let session = Arc::new(Session::default());
    let spec = LaunchSpec {
        exe: e.exe.clone(),
        home: e.home.clone(),
        cvars: small_window(),
        demo: Some(e.demo.clone()),
        config: "echo WD_TEST_SESSION_CFG\n".into(),
        extra_args: e.args.clone(),
        control_key: String::new(),
    };
    session.launch(spec, sink.clone()).unwrap();
    // Commands sent while the engine is still loading are queued, not lost.
    let early = session.send(&["echo WD_TEST_EARLY".into()]);
    wait_for("engine ready", 60, || sink.ready());
    assert_eq!(log_count(&e.home, "WD_TEST_SESSION_CFG"), 1);
    assert!(session.is_running());

    // Each batch must run exactly once, in order, even when sent back to back.
    for i in 0..40 {
        session.send(&[format!("echo WD_TEST_BATCH_{i}"), format!("echo \"WD_TEST quoted {i}\"")]).unwrap();
    }
    wait_for("last batch", 20, || log_count(&e.home, "WD_TEST_BATCH_39") > 0);
    for i in 0..40 {
        assert_eq!(log_count(&e.home, &format!("WD_TEST_BATCH_{i}")), 1, "batch {i}");
        assert_eq!(log_count(&e.home, &format!("WD_TEST quoted {i}")), 1, "quoted arg {i}");
    }
    assert_eq!(log_count(&e.home, "WD_TEST_EARLY"), 1, "early send returned {early:?}");

    // Seeking by server time lands where the parser says the match is.
    let target = info.game_start_time.unwrap_or(info.first_server_time) + 20_000;
    session.send(&[format!("seekservertime {target}"), "cl_freezeDemo 1".into()]).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    session.send(&["servertime".into()]).unwrap();
    wait_for("server time report", 20, || !sink.times().is_empty());
    let got = *sink.times().last().unwrap();
    assert!((got - target as f64).abs() < 500.0, "seek target {target}, engine reports {got}");

    session.stop();
    assert!(!session.is_running());
    wait_for("exit state", 5, || sink.last_state().map(|s| s["running"] == false).unwrap_or(false) || !session.is_running());
}

#[test]
fn render_queue_captures_and_encodes_a_clip() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFDECK_TEST_* not set");
        return;
    };
    let info = wolfdeck_lib::demo::parse_file(std::path::Path::new(&e.demo)).unwrap();
    let start = info.game_start_time.unwrap_or(info.first_server_time) + 10_000;
    let out_dir = std::path::Path::new(&e.home).join("encoded");
    let mut cvars = small_window();
    cvars.push(("cl_aviFrameRate".into(), "30".into()));
    cvars.push(("cl_aviCodec".into(), "mjpeg".into()));
    let job = RenderJob {
        id: "job1".into(),
        demo: e.demo.clone(),
        name: "wolfdeck test clip".into(),
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
    };
    let sink = Arc::new(Collect::default());
    let base = RenderBase { exe: e.exe, home: e.home.clone(), extra_args: e.args };
    run_queue(vec![job], base, sink.clone(), Arc::new(AtomicBool::new(false)));

    let events = sink.0.lock().unwrap();
    let last = events.iter().rev().find(|(ev, _)| ev == "render-update").map(|(_, p)| p.clone()).unwrap();
    assert_eq!(last["status"], "done", "render failed: {last}");
    assert!(events.iter().any(|(ev, p)| ev == "render-update" && p["status"] == "capturing" && p["progress"].as_f64().unwrap_or(0.0) >= 0.5));
    assert!(events.iter().any(|(ev, _)| ev == "render-finished"));
    let mp4 = out_dir.join("wolfdeck_test_clip.mp4");
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
    assert!(!std::path::Path::new(&e.home).join("wolfcam-ql/videos/wolfdeck_test_clip.avi").exists());
}
