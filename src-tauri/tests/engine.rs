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
    let pov = info.kills.iter().find(|k| !k.own_goal).map(|k| k.killer).expect("demo has kills");
    let sink = Arc::new(Collect::default());
    let session = Arc::new(Session::default());
    let spec = LaunchSpec {
        exe: e.exe.clone(),
        home: e.home.clone(),
        cvars: small_window(),
        demo: Some(e.demo.clone()),
        config: format!("echo WD_TEST_SESSION_CFG\n{}", wolfdeck_lib::render::follow_line(pov)),
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

    // The point of view requested at launch is in effect (`follow` without arguments reports it).
    session.send(&["follow".into()]).unwrap();
    let following = format!("currently following [{pov}]");
    wait_for("follow report", 20, || {
        let log = std::fs::read(std::path::Path::new(&e.home).join("wolfcam-ql/qconsole.log")).unwrap_or_default();
        String::from_utf8_lossy(&log).contains(&following)
    });

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
    // Second clip: lossless codec, engine motion blur, sound in a separate WAV, another POV.
    let mut blur = job.clone();
    blur.id = "job2".into();
    blur.name = "wolfdeck blur clip".into();
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
    let blur_mp4 = out_dir.join("wolfdeck_blur_clip.mp4");
    let streams = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
        .arg(&blur_mp4)
        .output()
        .unwrap();
    let streams = String::from_utf8_lossy(&streams.stdout);
    assert!(streams.contains("video") && streams.contains("audio"), "separate WAV must be muxed in: {streams}");
    assert!(std::path::Path::new(&e.home).join("wolfcam-ql/videos/wolfdeck_blur_clip.avi").exists(), "source kept when asked");
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

/// The Player's tool buttons: camera points (add, undo, edit), demo cutting
/// and screenshots, as issued by the UI.
#[test]
fn player_tools_drive_camera_recording_and_screenshots() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFDECK_TEST_* not set");
        return;
    };
    let info = wolfdeck_lib::demo::parse_file(std::path::Path::new(&e.demo)).unwrap();
    let game = std::path::Path::new(&e.home).join("wolfcam-ql");
    let sink = Arc::new(Collect::default());
    let session = Arc::new(Session::default());
    let spec = LaunchSpec {
        exe: e.exe.clone(),
        home: e.home.clone(),
        cvars: small_window(),
        demo: Some(e.demo.clone()),
        config: String::new(),
        extra_args: e.args.clone(),
        control_key: String::new(),
    };
    // A custom HUD chosen in the Config view: installed, then named in cg_hudFiles.
    let hud_src = std::path::Path::new(&e.home).join("wdtest.menu");
    std::fs::write(&hud_src, "menuDef {\n\tname \"wdtest\"\n\tfullScreen 0\n\tvisible 1\n\trect 0 0 640 480\n}\n").unwrap();
    let hud = wolfdeck_lib::paths::install_hud(&e.exe, &e.home, &hud_src.to_string_lossy()).unwrap();
    let mut spec = spec;
    spec.cvars.push(("cg_hudFiles".into(), hud.clone()));
    session.launch(spec, sink.clone()).unwrap();
    wait_for("engine ready", 60, || sink.ready());
    let log_text = || String::from_utf8_lossy(&std::fs::read(game.join("qconsole.log")).unwrap_or_default()).into_owned();
    let loaded = log_text().lines().find(|l| l.contains("CG_LoadMenus()")).unwrap_or_default().to_string();
    assert!(loaded.contains(&hud), "the profile's HUD must be the one loaded at start, got: {loaded}");
    let t0 = info.game_start_time.unwrap_or(info.first_server_time) + 15_000;
    let step = |cmds: &[String]| {
        session.send(cmds).unwrap();
        std::thread::sleep(Duration::from_millis(700));
    };
    let s = |x: &str| x.to_string();
    let camera_points = |name: &str| -> usize {
        let dir = game.join("cameras");
        let file = std::fs::read_dir(&dir).ok().and_then(|rd| {
            rd.flatten().map(|f| f.path()).find(|p| p.file_name().unwrap().to_string_lossy().starts_with(&format!("{name}.cam")))
        });
        file.map(|f| String::from_utf8_lossy(&std::fs::read(f).unwrap()).matches("camera point").count()).unwrap_or(0)
    };

    // Three camera points, two seconds apart.
    step(&[s("cl_freezeDemo 1"), s("freecam"), format!("seekservertime {t0}")]);
    step(&[s("addcamerapoint")]);
    step(&[format!("seekservertime {}", t0 + 2000)]);
    step(&[s("addcamerapoint")]);
    step(&[format!("seekservertime {}", t0 + 4000)]);
    step(&[s("addcamerapoint"), s("savecamera wdthree")]);
    wait_for("camera file", 10, || camera_points("wdthree") > 0);
    assert_eq!(camera_points("wdthree"), 3);

    // "Apply to all points" changes the path type of every existing point.
    let types = |name: &str| -> Vec<String> {
        let dir = game.join("cameras");
        let file = std::fs::read_dir(&dir).unwrap().flatten().map(|f| f.path()).find(|p| p.file_name().unwrap().to_string_lossy().starts_with(&format!("{name}.cam"))).unwrap();
        String::from_utf8_lossy(&std::fs::read(file).unwrap()).lines().filter(|l| l.trim_end().ends_with("  type")).map(|l| l.split_whitespace().next().unwrap().to_string()).collect()
    };
    let before = types("wdthree");
    step(&[s("selectcamerapoint all"), s("ecam type jump"), s("savecamera wdjump")]);
    wait_for("retyped camera file", 10, || camera_points("wdjump") == 3);
    let after = types("wdjump");
    assert!(after.iter().all(|t| *t == after[0]) && after != before, "types before {before:?}, after {after:?}");

    // Undo removes the newest point only.
    step(&[s("selectcamerapoint last"), s("deletecamerapoint"), s("savecamera wdtwo")]);
    wait_for("camera file after undo", 10, || camera_points("wdtwo") > 0);
    assert_eq!(camera_points("wdtwo"), 2);

    // Edit previous/next jumps to a camera point's time.
    step(&[s("editcamerapoint previous")]);
    session.send(&[s("servertime")]).unwrap();
    wait_for("server time report", 10, || !sink.times().is_empty());
    let at = *sink.times().last().unwrap();
    assert!((at - t0 as f64).abs() < 100.0 || (at - (t0 + 2000) as f64).abs() < 100.0, "edit point moved to {at}, points are at {t0} and {}", t0 + 2000);

    // Cut a demo out of the one that is playing; the result must parse.
    step(&[s("record wdcut"), s("cl_freezeDemo 0")]);
    std::thread::sleep(Duration::from_secs(2));
    step(&[s("stoprecord"), s("screenshotJPEG")]);
    let cut = game.join("demos").join("wdcut.dm_73");
    wait_for("cut demo", 10, || cut.is_file());
    let cut_info = wolfdeck_lib::demo::parse_file(&cut).expect("cut demo parses");
    assert_eq!(cut_info.map, info.map);
    assert!(cut_info.snapshots > 20, "cut demo has {} snapshots", cut_info.snapshots);
    wait_for("screenshot", 10, || std::fs::read_dir(game.join("screenshots")).map(|rd| rd.count() > 0).unwrap_or(false));

    // Looping between two marks keeps playback inside the range.
    step(&[format!("loop {} {}", t0 + 6000, t0 + 7000), format!("seekservertime {}", t0 + 6000)]);
    std::thread::sleep(Duration::from_millis(3500));
    let seen = sink.times().len();
    session.send(&[s("servertime")]).unwrap();
    wait_for("server time while looping", 10, || sink.times().len() > seen);
    let at = *sink.times().last().unwrap();
    assert!(at >= (t0 + 5900) as f64 && at <= (t0 + 7200) as f64, "loop left its range: {at}");
    step(&[s("loop")]);

    // The engine survives a video restart mid-demo and keeps taking commands (profile "Apply now").
    step(&[s("set r_picmip 1"), s("vid_restart")]);
    session.send(&[s("echo WD_AFTER_RESTART")]).unwrap();
    wait_for("command after vid_restart", 40, || log_text().contains("WD_AFTER_RESTART"));
    assert!(session.is_running());

    session.stop();
}

/// Key binds from the Keys view: applied at launch, changed while running,
/// effective for real key presses, and readable back from the engine's config.
#[test]
fn key_binds_apply_and_round_trip() {
    let Some(e) = env() else {
        eprintln!("skipped: WOLFDECK_TEST_* not set");
        return;
    };
    let game = std::path::Path::new(&e.home).join("wolfcam-ql");
    let sink = Arc::new(Collect::default());
    let session = Arc::new(Session::default());
    // What the UI generates for a key map: clear everything, then bind.
    let binds = "unbindall\nbind SPACE \"pause\"\nbind u \"selectcamerapoint last; deletecamerapoint\"\nbind [ \"editcamerapoint previous\"\nbind MWHEELUP \"fastforward 1\"\nbind F9 \"video avi name :demoname\"\n";
    let mut cvars = small_window();
    cvars.push(("in_nograb".into(), "1".into()));
    let spec = LaunchSpec {
        exe: e.exe.clone(),
        home: e.home.clone(),
        cvars,
        demo: Some(e.demo.clone()),
        config: binds.into(),
        extra_args: e.args.clone(),
        control_key: String::new(),
    };
    session.launch(spec, sink.clone()).unwrap();
    wait_for("engine ready", 60, || sink.ready());
    let log_text = || String::from_utf8_lossy(&std::fs::read(game.join("qconsole.log")).unwrap_or_default()).into_owned();

    // `bind <key>` reports what a key is bound to.
    session.send(&["bind SPACE".into(), "bind u".into(), "bind ENTER".into()]).unwrap();
    wait_for("bind report", 20, || log_text().contains("\"u\" = \"selectcamerapoint last; deletecamerapoint\""));
    assert!(log_text().contains("\"SPACE\" = \"pause\""));
    assert!(log_text().contains("\"ENTER\" is not bound"), "unbindall must have removed WolfcamQL's default bind");

    // A real key press runs the bind: Space pauses, so the demo time stops moving.
    let xdotool = std::process::Command::new("sh")
        .args(["-c", "w=$(xdotool search --name 'wolfcam' | head -1) && xdotool windowfocus $w && sleep 0.3 && xdotool key space"])
        .status();
    if xdotool.map(|s| s.success()).unwrap_or(false) {
        let report = |n: usize| {
            session.send(&["servertime".into()]).unwrap();
            wait_for("server time", 10, || sink.times().len() > n);
            *sink.times().last().unwrap()
        };
        std::thread::sleep(Duration::from_millis(500));
        let first = report(sink.times().len());
        std::thread::sleep(Duration::from_millis(1500));
        let second = report(sink.times().len());
        assert_eq!(first, second, "Space is bound to pause, so time must not advance");
    } else {
        eprintln!("xdotool not available: skipped the real key press");
    }

    // Changing the map while running replaces the binds.
    session.send(&["unbindall".into(), "bind p \"stopcamera\"".into(), "bind SPACE \"freecam\"".into()]).unwrap();
    session.send(&["bind SPACE".into(), "bind u".into()]).unwrap();
    wait_for("changed binds", 20, || log_text().contains("\"SPACE\" = \"freecam\""));
    assert!(log_text().contains("\"u\" is not bound"));

    // The engine saves its binds on exit; WolfDeck reads them back for "Import from WolfcamQL".
    session.stop();
    let saved = wolfdeck_lib::paths::read_binds(&e.home).unwrap();
    assert!(saved.contains(&("SPACE".to_string(), "freecam".to_string())), "{saved:?}");
    assert!(saved.contains(&("p".to_string(), "stopcamera".to_string())), "{saved:?}");
    assert_eq!(saved.len(), 2, "{saved:?}");
}
