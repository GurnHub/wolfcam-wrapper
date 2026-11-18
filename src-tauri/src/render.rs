//! Unattended capture: for every clip, WolfcamQL is started with a script
//! that seeks, records between two server times and quits; the result can
//! then be encoded with ffmpeg.

use crate::session::{game_home, spawn, LaunchSpec, LogTail, Sink};
use serde::Deserialize;
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EncodeSpec {
    pub ffmpeg: String,
    /// ffmpeg arguments placed between the inputs and the output file.
    pub args: Vec<String>,
    pub extension: String,
    pub output_dir: String,
    pub delete_source: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderJob {
    pub id: String,
    pub demo: String,
    /// Base name of the output files.
    pub name: String,
    pub start_time: i32,
    pub end_time: i32,
    /// Client number to follow; `None` keeps the recorded point of view.
    pub pov: Option<i32>,
    /// Lead-in played before recording starts so the scene has settled.
    pub pre_roll_ms: i32,
    /// Cvars for the command line (resolution, frame rate, blur, codec ...).
    pub cvars: Vec<(String, String)>,
    /// Config text executed once the demo has loaded (profile, HUD ...).
    pub config: String,
    /// Arguments of the engine's `video` command, e.g. "avi" or "avins wav".
    pub video_args: String,
    pub encode: Option<EncodeSpec>,
    /// Game speed while recording: 0.5 records the clip in half-speed slow motion.
    /// 0 or missing means real time.
    pub speed: f64,
    /// Encode while recording: WolfcamQL streams the capture straight into
    /// ffmpeg, so no AVI is written to disk. Takes precedence over `encode`.
    pub pipe: Option<EncodeSpec>,
}

impl RenderJob {
    pub fn speed(&self) -> f64 {
        if self.speed > 0.0 && self.speed.is_finite() { self.speed.clamp(0.01, 10.0) } else { 1.0 }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderBase {
    pub exe: String,
    pub home: String,
    pub extra_args: Vec<String>,
}

/// File-system safe base name; the engine's `name` argument takes no quotes.
pub fn safe_name(s: &str) -> String {
    let n: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    let n = n.trim_matches(['_', '.']).to_string();
    if n.is_empty() { "clip".into() } else { n }
}

/// WolfcamQL crashes when `follow <n>` runs before the first snapshot has
/// been drawn, which is the case for anything executed right after `+demo`.
/// An `at` command with a time in the past fires on the first drawn frame.
pub fn follow_line(client: i32) -> String {
    format!("at 1 follow {client}\n")
}

/// The script appended to the job's config.
pub fn capture_script(job: &RenderJob) -> String {
    let name = safe_name(&job.name);
    let start = job.start_time;
    let end = job.end_time.max(start + 100);
    let mut s = String::new();
    s.push_str("\n// --- WolfDeck capture ---\n");
    s.push_str(&format!("cl_freezeDemo 0\ntimescale {}\n", job.speed()));
    if let Some(p) = job.pov {
        s.push_str(&follow_line(p));
    }
    s.push_str(&format!("seekservertime {}\n", start - job.pre_roll_ms.max(0)));
    let video = if job.video_args.trim().is_empty() { "avi" } else { job.video_args.trim() };
    s.push_str(&format!("at {start} video {video} name {name}\n"));
    for step in 1..10 {
        let t = start as i64 + (end as i64 - start as i64) * step / 10;
        s.push_str(&format!("at {t} echo WD_PROGRESS {}\n", step * 10));
    }
    s.push_str(&format!("at {end} stopvideo\n"));
    s.push_str(&format!("at {} quit\n", end + 250));
    s.push_str("echo WD_READY\n");
    s
}

/// True when `file` is one of the files WolfcamQL writes for a capture
/// called `name`: `name.ext`, numbered segments or frames (`name-0001.avi`,
/// `name-0000000001.tga`), and the depth / stereo / ffmpeg-log variants.
fn belongs_to(file: &str, name: &str) -> bool {
    let Some(rest) = file.strip_prefix(name) else { return false };
    if rest.starts_with('.') {
        return true;
    }
    let Some(rest) = rest.strip_prefix('-') else { return false };
    let first = rest.split(['-', '.']).next().unwrap_or("");
    let after = &rest[first.len()..];
    // Segments are numbered with 4 digits, image frames with 10, and both end the name.
    let number = matches!(first.len(), 4 | 10) && first.chars().all(|c| c.is_ascii_digit()) && after.starts_with('.');
    number || matches!(first, "depth" | "left" | "right" | "ffmpeg")
}

/// Files in the engine's video folder that belong to this capture.
pub fn find_outputs(videos: &Path, name: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(videos)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.file_name().map(|f| belongs_to(&f.to_string_lossy(), name)).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// What to report back for a capture: image sequences produce thousands of
/// files, so those are summarised by their first frame.
fn summarise(outputs: &[PathBuf]) -> Vec<String> {
    let images = outputs.iter().filter(|p| ["tga", "png", "jpg"].iter().any(|e| is_ext(p, e))).count();
    let mut v: Vec<String> = outputs
        .iter()
        .filter(|p| !["tga", "png", "jpg"].iter().any(|e| is_ext(p, e)))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let Some(first) = outputs.iter().find(|p| ["tga", "png", "jpg"].iter().any(|e| is_ext(p, e))) {
        v.insert(0, first.to_string_lossy().into_owned());
        if images > 1 {
            v.push(format!("{images} image files"));
        }
    }
    v
}

fn is_ext(p: &Path, ext: &str) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false)
}

fn is_depth(p: &Path) -> bool {
    p.file_name().map(|f| f.to_string_lossy().to_lowercase().contains("depth")).unwrap_or(false)
}

pub fn ffmpeg_command(ffmpeg: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(if ffmpeg.trim().is_empty() { "ffmpeg" } else { ffmpeg.trim() });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

pub fn ffmpeg_version(ffmpeg: &str) -> Result<String, String> {
    let out = ffmpeg_command(ffmpeg).arg("-version").output().map_err(|e| format!("cannot run ffmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().map(|l| l.to_string()).filter(|l| l.contains("ffmpeg")).ok_or_else(|| "not an ffmpeg executable".into())
}

/// Encodes the captured AVI segment(s) (and a separate WAV, when present)
/// into one file. Returns the output path.
fn encode(job: &RenderJob, spec: &EncodeSpec, outputs: &[PathBuf], cancel: &AtomicBool, report: &dyn Fn(f64)) -> Result<PathBuf, String> {
    let avis: Vec<&PathBuf> = outputs.iter().filter(|p| is_ext(p, "avi") && !is_depth(p)).collect();
    if avis.is_empty() {
        return Err("nothing to encode: the capture produced no AVI file".into());
    }
    let out_dir = if spec.output_dir.trim().is_empty() { avis[0].parent().unwrap().to_path_buf() } else { PathBuf::from(spec.output_dir.trim()) };
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create {}: {e}", out_dir.display()))?;
    let ext = if spec.extension.trim().is_empty() { "mp4" } else { spec.extension.trim().trim_start_matches('.') };
    let out = out_dir.join(format!("{}.{ext}", safe_name(&job.name)));

    let mut cmd = ffmpeg_command(&spec.ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"]);
    let list = avis[0].with_extension("concat.txt");
    if avis.len() == 1 {
        cmd.arg("-i").arg(avis[0]);
    } else {
        let text: String = avis.iter().map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''"))).collect();
        std::fs::write(&list, text).map_err(|e| e.to_string())?;
        cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(&list);
    }
    let wav = outputs.iter().find(|p| is_ext(p, "wav"));
    if let Some(w) = wav {
        cmd.arg("-i").arg(w).args(["-map", "0:v:0", "-map", "1:a:0"]);
    }
    cmd.args(&spec.args).arg(&out).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot run ffmpeg: {e}"))?;
    // Slow motion makes the video longer than the stretch of demo it shows.
    let total_us = (job.end_time - job.start_time).max(1) as f64 * 1000.0 / job.speed();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                break;
            }
            if let Some(us) = line.strip_prefix("out_time_us=").or(line.strip_prefix("out_time_ms=")).and_then(|v| v.trim().parse::<f64>().ok()) {
                report((us / total_us).clamp(0.0, 1.0));
            }
        }
    }
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let _ = e.read_to_string(&mut err);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&list);
    if cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(&out);
        return Err("cancelled".into());
    }
    if !status.success() {
        let tail: Vec<&str> = err.lines().rev().take(4).collect();
        return Err(format!("ffmpeg failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | ")));
    }
    if spec.delete_source {
        for p in avis {
            let _ = std::fs::remove_file(p);
        }
        if let Some(w) = wav {
            let _ = std::fs::remove_file(w);
        }
    }
    Ok(out)
}

/// Keeps the clip inside the demo. WolfcamQL never reaches a time past the
/// demo's last snapshot, so `stopvideo` and `quit` scheduled there would never
/// run and the render would wait forever.
pub fn clamp_to_demo(job: &mut RenderJob, last_server_time: i32) -> Result<(), String> {
    // The last snapshots are not always reached exactly; stay a little before them.
    let last = last_server_time - 300;
    if job.start_time >= last - 100 {
        return Err("the clip starts after the end of the demo".into());
    }
    job.end_time = job.end_time.min(last);
    Ok(())
}

/// A capture that neither reports progress nor writes anything for this long
/// is considered stuck (for example a clip that runs into a broken part of a demo).
const STALL_TIMEOUT: Duration = Duration::from_secs(300);

fn run_job(job: &RenderJob, base: &RenderBase, sink: &dyn Sink, cancel: &AtomicBool) -> Result<Vec<String>, String> {
    let update = |status: &str, progress: f64, message: &str| {
        sink.emit("render-update", json!({ "id": job.id, "status": status, "progress": progress, "message": message }));
    };
    if !Path::new(&job.demo).is_file() {
        return Err(format!("demo not found: {}", job.demo));
    }
    let info = crate::demo::parse_file(Path::new(&job.demo)).map_err(|e| format!("cannot read the demo: {e}"))?;
    let mut job = job.clone();
    clamp_to_demo(&mut job, info.last_server_time)?;
    let job = &job;
    let name = safe_name(&job.name);
    let videos = game_home(&base.home).join("videos");
    for old in find_outputs(&videos, &name) {
        let _ = std::fs::remove_file(old);
    }
    let mut cvars = job.cvars.clone();
    let mut video_args = job.video_args.clone();
    let mut path_prepend = Vec::new();
    if let Some(pipe) = &job.pipe {
        // The engine runs `ffmpeg -f avi -i - <cl_aviPipeCommand> videos/<name>.<cl_aviPipeExtension>`.
        let args = pipe.args.join(" ");
        if args.contains(['"', ';']) {
            return Err("encode arguments cannot contain quotes or semicolons when encoding while recording".into());
        }
        cvars.push(("cl_aviPipeCommand".into(), format!("-y {args}")));
        cvars.push(("cl_aviPipeExtension".into(), pipe_extension(pipe)));
        video_args = if video_args.split_whitespace().any(|a| a == "avins") { "avins pipe".into() } else { "avi pipe".into() };
        let ff = Path::new(pipe.ffmpeg.trim());
        if let Some(dir) = ff.parent().filter(|d| ff.is_absolute() && !d.as_os_str().is_empty()) {
            path_prepend.push(dir.to_string_lossy().into_owned());
        }
    }
    let mut capture_job = job.clone();
    capture_job.video_args = video_args;
    let spec = LaunchSpec {
        exe: base.exe.clone(),
        home: base.home.clone(),
        cvars,
        demo: Some(job.demo.clone()),
        config: format!("{}\n{}", job.config, capture_script(&capture_job)),
        extra_args: base.extra_args.clone(),
        control_key: String::new(),
        path_prepend,
    };
    update("capturing", 0.0, "Starting WolfcamQL");
    let mut child = spawn(&spec)?;
    let mut tail = LogTail::new(&base.home);
    let mut recent: Vec<String> = Vec::new();
    let mut ready = false;
    // Watchdog: the capture is alive while progress is reported or its files grow.
    let mut last_activity = Instant::now();
    let mut last_size = 0u64;
    let mut checked = Instant::now();
    let exit = loop {
        std::thread::sleep(Duration::from_millis(200));
        for line in tail.poll() {
            if let Some(p) = line.strip_prefix("WD_PROGRESS ").and_then(|p| p.trim().parse::<f64>().ok()) {
                update("capturing", p / 100.0, "Recording");
            } else if line.starts_with("WD_READY") {
                ready = true;
                update("capturing", 0.0, "Seeking to the clip");
            }
            if line.starts_with("WD_PROGRESS ") || line.starts_with("WD_READY") {
                last_activity = Instant::now();
            }
            let l = line.to_lowercase();
            if l.contains("error") || l.contains("can't") || l.contains("couldn't open") || l.contains("unknown command") {
                recent.push(line);
                if recent.len() > 6 {
                    recent.remove(0);
                }
            }
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        if checked.elapsed() >= Duration::from_secs(2) {
            checked = Instant::now();
            let size: u64 = find_outputs(&videos, &name).iter().filter_map(|p| p.metadata().ok()).map(|m| m.len()).sum();
            if size != last_size {
                last_size = size;
                last_activity = Instant::now();
            }
            if last_activity.elapsed() >= STALL_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "WolfcamQL stopped making progress for {} minutes and was stopped. {}",
                    STALL_TIMEOUT.as_secs() / 60,
                    recent.join(" | ")
                ));
            }
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
    };
    let outputs = find_outputs(&videos, &name);
    if outputs.is_empty() {
        let why = if !ready {
            "WolfcamQL exited before the demo finished loading"
        } else {
            "WolfcamQL exited without writing any video"
        };
        return Err(format!("{why} (exit {}). {}", exit.code().map(|c| c.to_string()).unwrap_or("?".into()), recent.join(" | ")));
    }
    if let Some(pipe) = &job.pipe {
        return finish_pipe(job, pipe, &videos, &name, &outputs);
    }
    let mut result = summarise(&outputs);
    if let Some(enc) = &job.encode {
        update("encoding", 0.0, "Encoding");
        let out = encode(job, enc, &outputs, cancel, &|p| update("encoding", p, "Encoding"))?;
        result = summarise(&find_outputs(&videos, &name));
        result.insert(0, out.to_string_lossy().into_owned());
    }
    Ok(result)
}

fn pipe_extension(pipe: &EncodeSpec) -> String {
    let e = pipe.extension.trim().trim_start_matches('.');
    if e.is_empty() { "mp4".into() } else { e.to_string() }
}

/// After a piped capture: check that ffmpeg produced the file and move it to
/// the output folder.
fn finish_pipe(job: &RenderJob, pipe: &EncodeSpec, videos: &Path, name: &str, outputs: &[PathBuf]) -> Result<Vec<String>, String> {
    let made = videos.join(format!("{name}.{}", pipe_extension(pipe)));
    let log = videos.join(format!("{name}-ffmpeg.log"));
    let ok = made.metadata().map(|m| m.len() > 1024).unwrap_or(false);
    if !ok {
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
        let why = if tail.is_empty() {
            "ffmpeg did not produce a video. Check that ffmpeg is installed (Settings) and the encode arguments are valid.".to_string()
        } else {
            format!("ffmpeg failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | "))
        };
        return Err(why);
    }
    let _ = std::fs::remove_file(&log);
    let mut out = made.clone();
    if !pipe.output_dir.trim().is_empty() {
        let dir = PathBuf::from(pipe.output_dir.trim());
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let target = dir.join(made.file_name().unwrap());
        if std::fs::rename(&made, &target).is_err() {
            std::fs::copy(&made, &target).map_err(|e| format!("moving the video: {e}"))?;
            let _ = std::fs::remove_file(&made);
        }
        out = target;
    }
    let _ = job;
    let mut result = vec![out.to_string_lossy().into_owned()];
    // A separate WAV or depth pass still lands in the videos folder.
    result.extend(summarise(outputs).into_iter().filter(|p| Path::new(p) != made && Path::new(p) != log));
    Ok(result)
}

/// Runs the jobs one after another, reporting through `render-update` and
/// finishing with `render-finished`.
pub fn run_queue(jobs: Vec<RenderJob>, base: RenderBase, sink: Arc<dyn Sink>, cancel: Arc<AtomicBool>) {
    for job in &jobs {
        if cancel.load(Ordering::Relaxed) {
            sink.emit("render-update", json!({ "id": job.id, "status": "cancelled", "progress": 0.0, "message": "Cancelled" }));
            continue;
        }
        match run_job(job, &base, &*sink, &cancel) {
            Ok(outputs) => sink.emit("render-update", json!({ "id": job.id, "status": "done", "progress": 1.0, "message": "Done", "outputs": outputs })),
            Err(e) => {
                let status = if e == "cancelled" { "cancelled" } else { "failed" };
                sink.emit("render-update", json!({ "id": job.id, "status": status, "progress": 0.0, "message": e }));
            }
        }
    }
    sink.emit("render-finished", json!({ "cancelled": cancel.load(Ordering::Relaxed) }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_script_orders_seek_record_stop_quit() {
        let job = RenderJob { name: "my clip (1)".into(), start_time: 100_000, end_time: 110_000, pov: Some(3), pre_roll_ms: 4000, ..Default::default() };
        let s = capture_script(&job);
        let pos = |needle: &str| s.find(needle).unwrap_or_else(|| panic!("missing {needle}"));
        assert!(pos("at 1 follow 3") < pos("seekservertime 96000"));
        assert!(!s.contains("\nfollow "), "a bare follow before the first frame crashes the engine");
        assert!(pos("seekservertime 96000") < pos("at 100000 video avi name my_clip__1"));
        assert!(pos("at 100000 video") < pos("at 105000 echo WD_PROGRESS 50"));
        assert!(pos("at 110000 stopvideo") < pos("at 110250 quit"));
    }

    #[test]
    fn slow_motion_sets_the_timescale() {
        let mut job = RenderJob { name: "x".into(), start_time: 1000, end_time: 5000, ..Default::default() };
        assert!(capture_script(&job).contains("timescale 1\n"));
        job.speed = 0.25;
        assert!(capture_script(&job).contains("timescale 0.25\n"));
        job.speed = f64::NAN;
        assert_eq!(job.speed(), 1.0);
    }

    #[test]
    fn clips_are_kept_inside_the_demo() {
        let mut job = RenderJob { start_time: 10_000, end_time: 90_000, ..Default::default() };
        clamp_to_demo(&mut job, 60_000).unwrap();
        assert_eq!(job.end_time, 59_700);
        let mut late = RenderJob { start_time: 59_800, end_time: 61_000, ..Default::default() };
        assert!(clamp_to_demo(&mut late, 60_000).is_err());
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_name("a b/c:d"), "a_b_c_d");
        assert_eq!(safe_name("..."), "clip");
        assert_eq!(safe_name("ok-name_1.2"), "ok-name_1.2");
    }

    #[test]
    fn outputs_are_matched_by_exact_base_name() {
        let d = std::env::temp_dir().join(format!("wolfdeck-out-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        for f in [
            "clip.avi", "clip-0001.avi", "clip.wav", "clip-depth.avi", "clip-left-0000000003.tga", "clip-ffmpeg.log",
            "clip2.avi", "clip-2.avi", "clip-2-depth.avi", "clip-final.mp4", "clip-12345.avi", "other.avi", "clip-0000000007.png",
        ] {
            std::fs::write(d.join(f), b"x").unwrap();
        }
        let names: Vec<String> = find_outputs(&d, "clip").iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        // "clip-2" is another clip's output; it must not be taken (or deleted) as part of "clip".
        assert_eq!(names, vec!["clip-0000000007.png", "clip-0001.avi", "clip-depth.avi", "clip-ffmpeg.log", "clip-left-0000000003.tga", "clip.avi", "clip.wav"]);
        let two: Vec<String> = find_outputs(&d, "clip-2").iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(two, vec!["clip-2-depth.avi", "clip-2.avi"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
