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
use std::time::Duration;

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
    s.push_str("cl_freezeDemo 0\ntimescale 1\n");
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

/// Files in the engine's video folder that belong to this capture.
pub fn find_outputs(videos: &Path, name: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(videos)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let f = p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
                    p.is_file() && f.strip_prefix(name).map(|rest| rest.starts_with('.') || rest.starts_with('-')).unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
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
    let total_us = (job.end_time - job.start_time).max(1) as f64 * 1000.0;
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

fn run_job(job: &RenderJob, base: &RenderBase, sink: &dyn Sink, cancel: &AtomicBool) -> Result<Vec<String>, String> {
    let update = |status: &str, progress: f64, message: &str| {
        sink.emit("render-update", json!({ "id": job.id, "status": status, "progress": progress, "message": message }));
    };
    if !Path::new(&job.demo).is_file() {
        return Err(format!("demo not found: {}", job.demo));
    }
    let name = safe_name(&job.name);
    let videos = game_home(&base.home).join("videos");
    for old in find_outputs(&videos, &name) {
        let _ = std::fs::remove_file(old);
    }
    let spec = LaunchSpec {
        exe: base.exe.clone(),
        home: base.home.clone(),
        cvars: job.cvars.clone(),
        demo: Some(job.demo.clone()),
        config: format!("{}\n{}", job.config, capture_script(job)),
        extra_args: base.extra_args.clone(),
        control_key: String::new(),
    };
    update("capturing", 0.0, "Starting WolfcamQL");
    let mut child = spawn(&spec)?;
    let mut tail = LogTail::new(&base.home);
    let mut recent: Vec<String> = Vec::new();
    let mut ready = false;
    let exit = loop {
        std::thread::sleep(Duration::from_millis(200));
        for line in tail.poll() {
            if let Some(p) = line.strip_prefix("WD_PROGRESS ").and_then(|p| p.trim().parse::<f64>().ok()) {
                update("capturing", p / 100.0, "Recording");
            } else if line.starts_with("WD_READY") {
                ready = true;
                update("capturing", 0.0, "Seeking to the clip");
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
    let mut result: Vec<String> = outputs.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    if let Some(enc) = &job.encode {
        update("encoding", 0.0, "Encoding");
        let out = encode(job, enc, &outputs, cancel, &|p| update("encoding", p, "Encoding"))?;
        result = find_outputs(&videos, &name).iter().map(|p| p.to_string_lossy().into_owned()).collect();
        result.insert(0, out.to_string_lossy().into_owned());
    }
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
    fn names_are_made_safe() {
        assert_eq!(safe_name("a b/c:d"), "a_b_c_d");
        assert_eq!(safe_name("..."), "clip");
        assert_eq!(safe_name("ok-name_1.2"), "ok-name_1.2");
    }

    #[test]
    fn outputs_are_matched_by_exact_base_name() {
        let d = std::env::temp_dir().join(format!("wolfdeck-out-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        for f in ["clip.avi", "clip-0001.avi", "clip.wav", "clip2.avi", "other.avi"] {
            std::fs::write(d.join(f), b"x").unwrap();
        }
        let names: Vec<String> = find_outputs(&d, "clip").iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["clip-0001.avi", "clip.avi", "clip.wav"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
