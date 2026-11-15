//! WolfDeck backend: demo parsing, library, WolfcamQL control and rendering.

pub mod demo;
pub mod library;
pub mod paths;
pub mod render;
pub mod session;

use serde_json::Value;
use session::{Session, Sink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppSink(AppHandle);

impl Sink for AppSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

#[derive(Default)]
struct Backend {
    session: Arc<Session>,
    render_cancel: Arc<AtomicBool>,
    render_running: Arc<AtomicBool>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn store_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid store name".into());
    }
    Ok(data_dir(app)?.join(format!("{name}.json")))
}

#[tauri::command]
fn store_load(app: AppHandle, name: String) -> Result<Value, String> {
    let f = store_file(&app, &name)?;
    match std::fs::read(&f) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{}: {e}", f.display())),
        Err(_) => Ok(Value::Null),
    }
}

#[tauri::command]
fn store_save(app: AppHandle, name: String, value: Value) -> Result<(), String> {
    let f = store_file(&app, &name)?;
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

#[tauri::command]
fn detect_paths() -> paths::Detected {
    paths::detect()
}

#[tauri::command]
fn check_install(exe: String, home: String, ql_path: String) -> paths::InstallStatus {
    paths::check_install(&exe, &home, &ql_path)
}

#[tauri::command]
async fn sync_paks(exe: String, home: String, ql_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || paths::sync_paks(&exe, &home, &ql_path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_game_files(exe: String, home: String, sub: String, exts: Vec<String>) -> Vec<paths::GameFile> {
    let exts: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    paths::list_game_files(&exe, &home, &sub, &exts)
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let md = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if md.len() > 2 * 1024 * 1024 {
        return Err("file is too large to edit here".into());
    }
    Ok(String::from_utf8_lossy(&std::fs::read(&path).map_err(|e| e.to_string())?).into_owned())
}

/// Writes a config file below `<home>/wolfcam-ql`; `name` is relative to it.
#[tauri::command]
fn write_game_file(home: String, name: String, text: String) -> Result<String, String> {
    let rel = Path::new(&name);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err("invalid file name".into());
    }
    let f = session::game_home(&home).join(rel);
    if let Some(p) = f.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&f, text).map_err(|e| e.to_string())?;
    Ok(f.to_string_lossy().into_owned())
}

#[tauri::command]
async fn scan_library(app: AppHandle, dirs: Vec<String>, force: bool) -> Result<Vec<library::DemoEntry>, String> {
    let cache = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        library::scan(&cache, &dirs, force, |done, total| {
            let _ = app.emit("library-progress", serde_json::json!({ "done": done, "total": total }));
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_demo(app: AppHandle, path: String) -> Result<demo::DemoInfo, String> {
    let cache = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || library::get_demo(&cache, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_frags(app: AppHandle, paths: Vec<String>, filter: library::FragFilter) -> Result<Vec<library::Frag>, String> {
    let cache = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || library::search_frags(&cache, &paths, &filter)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn demo_trash(paths: Vec<String>) -> Result<(), String> {
    trash::delete_all(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
fn demo_rename(path: String, new_name: String) -> Result<String, String> {
    let from = Path::new(&path);
    if new_name.is_empty() || new_name.contains(['/', '\\']) {
        return Err("invalid file name".into());
    }
    let mut to = from.with_file_name(&new_name);
    if to.extension().is_none() {
        if let Some(ext) = from.extension() {
            to.set_extension(ext);
        }
    }
    if to.exists() {
        return Err("a file with that name already exists".into());
    }
    std::fs::rename(from, &to).map_err(|e| e.to_string())?;
    Ok(to.to_string_lossy().into_owned())
}

#[tauri::command]
fn demo_move(paths: Vec<String>, dir: String) -> Result<u32, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut moved = 0;
    for p in paths {
        let from = Path::new(&p);
        let Some(name) = from.file_name() else { continue };
        let to = Path::new(&dir).join(name);
        if to.exists() {
            return Err(format!("{} already exists in the target folder", name.to_string_lossy()));
        }
        if std::fs::rename(from, &to).is_err() {
            std::fs::copy(from, &to).map_err(|e| e.to_string())?; // other volume
            std::fs::remove_file(from).map_err(|e| e.to_string())?;
        }
        moved += 1;
    }
    Ok(moved)
}

#[tauri::command]
fn launch(app: AppHandle, state: State<Backend>, spec: session::LaunchSpec) -> Result<u32, String> {
    if state.render_running.load(Ordering::Relaxed) {
        return Err("a render is in progress".into());
    }
    state.session.launch(spec, Arc::new(AppSink(app)))
}

#[tauri::command]
fn send_commands(state: State<Backend>, commands: Vec<String>) -> Result<(), String> {
    state.session.send(&commands)
}

#[tauri::command]
async fn stop_wolfcam(app: AppHandle, state: State<'_, Backend>) -> Result<(), String> {
    let session = state.session.clone();
    tauri::async_runtime::spawn_blocking(move || session.stop()).await.map_err(|e| e.to_string())?;
    let _ = app.emit("wolfcam-state", serde_json::json!({ "running": false }));
    Ok(())
}

#[tauri::command]
fn wolfcam_running(state: State<Backend>) -> bool {
    state.session.is_running()
}

#[tauri::command]
fn start_render(app: AppHandle, state: State<Backend>, jobs: Vec<render::RenderJob>, base: render::RenderBase) -> Result<(), String> {
    if state.render_running.swap(true, Ordering::SeqCst) {
        return Err("a render is already in progress".into());
    }
    state.session.stop();
    state.render_cancel.store(false, Ordering::SeqCst);
    let (cancel, running) = (state.render_cancel.clone(), state.render_running.clone());
    std::thread::spawn(move || {
        render::run_queue(jobs, base, Arc::new(AppSink(app)), cancel);
        running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
fn cancel_render(state: State<Backend>) {
    state.render_cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn render_running(state: State<Backend>) -> bool {
    state.render_running.load(Ordering::Relaxed)
}

#[tauri::command]
fn ffmpeg_version(path: String) -> Result<String, String> {
    render::ffmpeg_version(&path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend::default())
        .invoke_handler(tauri::generate_handler![
            store_load,
            store_save,
            detect_paths,
            check_install,
            sync_paks,
            list_game_files,
            read_text,
            write_game_file,
            scan_library,
            get_demo,
            search_frags,
            demo_trash,
            demo_rename,
            demo_move,
            launch,
            send_commands,
            stop_wolfcam,
            wolfcam_running,
            start_render,
            cancel_render,
            render_running,
            ffmpeg_version,
        ])
        .on_window_event(|window, event| {
            // Do not leave an engine running that nothing controls any more.
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<Backend>();
                state.render_cancel.store(true, Ordering::SeqCst);
                state.session.stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running WolfDeck");
}
