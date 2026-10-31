//! Нативний шар CourtAnalyzer: робоча папка, файли, ZIP-архіви реєстру,
//! завантаження та шифрування ключів. Уся бізнес-логіка — у TypeScript.

mod download;
mod zipops;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{Manager, State};

struct AppState {
    data_dir: PathBuf,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn register(&self, op: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(op.to_string(), flag.clone());
        flag
    }
    fn release(&self, op: &str) {
        self.cancels.lock().unwrap().remove(op);
    }
}

/// Портативна робоча папка: поруч з exe, якщо туди можна писати; інакше — профіль користувача.
fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("COURT_ANALYZER_DATA") {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("CourtAnalyzer-data"))) {
        let probe = dir.join(".write-test");
        if fs::create_dir_all(&dir).is_ok() && fs::write(&probe, b"ok").is_ok() {
            let _ = fs::remove_file(probe);
            return dir;
        }
    }
    app.path().app_local_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("data")
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Файли

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    data_dir: String,
    version: String,
    encryption: bool,
    /// Режим автоматичних перевірок (змінна середовища CA_TEST).
    test_mode: bool,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle, state: State<AppState>) -> AppInfo {
    AppInfo {
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        version: app.package_info().version.to_string(),
        encryption: cfg!(windows),
        test_mode: std::env::var("CA_TEST").is_ok(),
    }
}

#[tauri::command]
fn read_text(path: String) -> Option<String> {
    fs::read_to_string(path).ok()
}

#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = format!("{path}.tmp");
    fs::write(&tmp, text).map_err(err)?;
    fs::rename(&tmp, p).map_err(err)
}

#[tauri::command]
fn read_bytes(path: String) -> Result<Response, String> {
    fs::read(path).map(Response::new).map_err(err)
}

/// Тіло запиту — сирі байти, шлях — у заголовку x-path (base64 UTF-8).
#[tauri::command]
fn write_bytes(request: Request) -> Result<(), String> {
    let encoded = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("немає шляху")?;
    let path = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).map_err(err)?).map_err(err)?;
    // Зазвичай тіло приходить сирими байтами; у резервному режимі IPC — JSON-масивом чисел.
    let data: Vec<u8> = match request.body() {
        InvokeBody::Raw(d) => d.clone(),
        InvokeBody::Json(v) => serde_json::from_value(v.clone()).map_err(err)?,
    };
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(path, data).map_err(err)
}

#[tauri::command]
fn remove_path(state: State<AppState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.starts_with(&state.data_dir) {
        return Err("видаляти можна лише в робочій папці".into());
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(err)
    } else if p.exists() {
        fs::remove_file(p).map_err(err)
    } else {
        Ok(())
    }
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        fs::remove_file(&to).map_err(err)?;
    }
    fs::rename(from, to).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stat {
    size: u64,
    mtime_ms: f64,
    is_dir: bool,
}

#[tauri::command]
fn stat_path(path: String) -> Option<Stat> {
    let m = fs::metadata(path).ok()?;
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(Stat { size: m.len(), mtime_ms, is_dir: m.is_dir() })
}

#[tauri::command]
fn list_dir(path: String) -> Vec<String> {
    fs::read_dir(path)
        .map(|it| it.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

#[derive(Serialize)]
struct DirStats {
    files: u64,
    bytes: u64,
}

#[tauri::command]
fn dir_stats(path: String) -> DirStats {
    let mut s = DirStats { files: 0, bytes: 0 };
    if let Ok(it) = fs::read_dir(path) {
        for m in it.filter_map(|e| e.ok()).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()) {
            s.files += 1;
            s.bytes += m.len();
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Архіви реєстру

#[tauri::command]
async fn zip_entries(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || zipops::entries(&path)).await.map_err(err)?
}

#[tauri::command]
async fn zip_tables(path: String, names: Vec<String>) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || zipops::tables(&path, &names)).await.map_err(err)?
}

#[tauri::command]
async fn zip_probe(source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || zipops::probe(&source)).await.map_err(err)?
}

#[tauri::command]
async fn zip_scan(state: State<'_, AppState>, path: String, ids: Vec<String>, op: String, on_progress: Channel<f64>) -> Result<zipops::ScanResult, String> {
    let flag = state.register(&op);
    let result = tauri::async_runtime::spawn_blocking(move || {
        zipops::scan(&path, &ids, &flag, &|f| {
            let _ = on_progress.send(f);
        })
    })
    .await
    .map_err(err)?;
    state.release(&op);
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn download_file(
    state: State<'_, AppState>,
    url: String,
    dest: String,
    resume_from: u64,
    if_range: Option<String>,
    op: String,
    on_progress: Channel<(u64, u64)>,
) -> Result<download::DownloadResult, String> {
    let flag = state.register(&op);
    let result = tauri::async_runtime::spawn_blocking(move || {
        download::download(&url, &dest, resume_from, if_range, &flag, &|d, t| {
            let _ = on_progress.send((d, t));
        })
    })
    .await
    .map_err(err)?;
    state.release(&op);
    result
}

#[tauri::command]
fn cancel_op(state: State<AppState>, op: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&op) {
        flag.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Шифрування API-ключів (Windows DPAPI: розшифрувати може лише той самий користувач Windows)

#[cfg(windows)]
fn dpapi(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output)
        }
    };
    if ok == 0 {
        return Err("не вдалося розшифрувати (ключ збережено іншим користувачем Windows або на іншому комп'ютері)".into());
    }
    let out = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    Ok(out)
}

#[cfg(not(windows))]
fn dpapi(data: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[tauri::command]
fn protect(text: String) -> Result<String, String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(dpapi(text.as_bytes(), true)?))
}

#[tauri::command]
fn unprotect(value: String) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(value).map_err(err)?;
    String::from_utf8(dpapi(&raw, false)?).map_err(err)
}

// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            fs::create_dir_all(&data_dir)?;
            app.manage(AppState { data_dir: data_dir.clone(), cancels: Mutex::new(HashMap::new()) });
            let page = std::env::var("CA_PAGE").map(|p| format!("index.html#page={p}")).unwrap_or_else(|_| "index.html".into());
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App(page.into()))
                .title("CourtAnalyzer — аналіз судових рішень")
                .inner_size(1320.0, 880.0)
                .min_inner_size(1000.0, 680.0)
                // Дані WebView2 (локальне сховище інтерфейсу) — теж у робочій папці.
                .data_directory(data_dir.join("webview"))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            read_text,
            write_text,
            read_bytes,
            write_bytes,
            remove_path,
            rename_path,
            stat_path,
            list_dir,
            dir_stats,
            zip_entries,
            zip_tables,
            zip_probe,
            zip_scan,
            download_file,
            cancel_op,
            protect,
            unprotect
        ])
        .run(tauri::generate_context!())
        .expect("не вдалося запустити застосунок");
}
