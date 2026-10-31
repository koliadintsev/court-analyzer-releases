//! Завантаження великих архівів у файл з прогресом, докачуванням і скасуванням.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub status: u16,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub size: u64,
    pub total: Option<u64>,
}

fn header(resp: &reqwest::blocking::Response, name: reqwest::header::HeaderName) -> Option<String> {
    resp.headers().get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

pub fn download(url: &str, dest: &str, resume_from: u64, if_range: Option<String>, cancel: &AtomicBool, progress: &dyn Fn(u64, u64)) -> Result<DownloadResult, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header(RANGE, format!("bytes={resume_from}-"));
        if let Some(tag) = if_range {
            req = req.header(IF_RANGE, tag);
        }
    }
    let mut resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    let append = status == 206 && resume_from > 0;
    let total = if append {
        header(&resp, CONTENT_RANGE).and_then(|v| v.rsplit('/').next().and_then(|t| t.parse().ok()))
    } else {
        header(&resp, CONTENT_LENGTH).and_then(|v| v.parse().ok())
    };
    let etag = header(&resp, ETAG);
    let last_modified = header(&resp, LAST_MODIFIED);

    if let Some(parent) = std::path::Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(dest)
        .map_err(|e| e.to_string())?;

    let mut done = if append { resume_from } else { 0 };
    let mut buf = vec![0u8; 1 << 20];
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let n = resp.read(&mut buf).map_err(|e| format!("з'єднання перервано: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            progress(done, total.unwrap_or(0));
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    progress(done, total.unwrap_or(done));
    Ok(DownloadResult { status, etag, last_modified, size: done, total })
}
