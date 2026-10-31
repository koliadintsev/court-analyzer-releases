//! Читання архівів відкритих даних ЄДРСР: довідники, початок documents.csv
//! (у т.ч. віддалено через HTTP Range) і потокове сканування за списком ID.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use zip::ZipArchive;

pub type Row = HashMap<String, String>;

fn find_entry<R: Read + Seek>(archive: &ZipArchive<R>, name: &str) -> Option<String> {
    archive
        .file_names()
        .find(|n| n.rsplit('/').next().map(|b| b.eq_ignore_ascii_case(name)).unwrap_or(false))
        .map(|s| s.to_string())
}

fn unquote(v: &str) -> String {
    let s = v.trim().trim_end_matches('\r');
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].replace("\"\"", "\"")
    } else {
        s.to_string()
    }
}

pub fn entries(path: &str) -> Result<Vec<String>, String> {
    let archive = ZipArchive::new(File::open(path).map_err(|e| e.to_string())?).map_err(|e| format!("Файл не є ZIP-архівом: {e}"))?;
    Ok(archive.file_names().map(|s| s.to_string()).collect())
}

/// Повністю читає невеликі записи (довідники) як текст.
pub fn tables(path: &str, names: &[String]) -> Result<HashMap<String, String>, String> {
    let mut archive = ZipArchive::new(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for name in names {
        if let Some(full) = find_entry(&archive, name) {
            let mut f = archive.by_name(&full).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            out.insert(name.clone(), String::from_utf8_lossy(&buf).into_owned());
        }
    }
    Ok(out)
}

fn head_of_documents<R: Read + Seek>(reader: R, limit: usize) -> Result<String, String> {
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("Не вдалося прочитати архів: {e}"))?;
    let name = find_entry(&archive, "documents.csv").ok_or("В архіві немає documents.csv")?;
    let f = archive.by_name(&name).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(limit);
    f.take(limit as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Перші ~256 КБ documents.csv з локального файлу або за URL (лише потрібні фрагменти через Range).
pub fn probe(source: &str) -> Result<String, String> {
    const LIMIT: usize = 256 * 1024;
    if source.starts_with("http://") || source.starts_with("https://") {
        head_of_documents(HttpRangeReader::open(source)?, LIMIT)
    } else {
        head_of_documents(File::open(source).map_err(|e| e.to_string())?, LIMIT)
    }
}

// ---------------------------------------------------------------------------

/// Read + Seek поверх HTTP Range-запитів з кешем блоків.
struct HttpRangeReader {
    client: reqwest::blocking::Client,
    url: String,
    size: u64,
    pos: u64,
    blocks: Vec<(u64, Vec<u8>)>,
}

const BLOCK: u64 = 128 * 1024;

impl HttpRangeReader {
    fn open(url: &str) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let mut r = HttpRangeReader { client, url: url.to_string(), size: 0, pos: 0, blocks: Vec::new() };
        let (data, total) = r.fetch(0, BLOCK - 1)?;
        r.size = total.ok_or("Сервер не підтримує часткове завантаження (HTTP Range)")?;
        r.blocks.push((0, data));
        Ok(r)
    }

    fn fetch(&self, start: u64, end: u64) -> Result<(Vec<u8>, Option<u64>), String> {
        let resp = self
            .client
            .get(&self.url)
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .send()
            .map_err(|e| e.to_string())?;
        if resp.status().as_u16() != 206 {
            return Err(format!("Сервер не підтримує часткове завантаження (HTTP {})", resp.status().as_u16()));
        }
        let total = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse::<u64>().ok());
        Ok((resp.bytes().map_err(|e| e.to_string())?.to_vec(), total))
    }
}

impl Read for HttpRangeReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.size || buf.is_empty() {
            return Ok(0);
        }
        let start = self.pos / BLOCK * BLOCK;
        if !self.blocks.iter().any(|(s, _)| *s == start) {
            let end = (start + BLOCK - 1).min(self.size - 1);
            let (data, _) = self.fetch(start, end).map_err(std::io::Error::other)?;
            if self.blocks.len() > 16 {
                self.blocks.remove(0);
            }
            self.blocks.push((start, data));
        }
        let (_, data) = self.blocks.iter().find(|(s, _)| *s == start).unwrap();
        let off = (self.pos - start) as usize;
        if off >= data.len() {
            return Ok(0);
        }
        let n = buf.len().min(data.len() - off);
        buf[..n].copy_from_slice(&data[off..off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let p = match pos {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::End(d) => self.size as i64 + d,
            SeekFrom::Current(d) => self.pos as i64 + d,
        };
        if p < 0 {
            return Err(std::io::Error::other("seek before start"));
        }
        self.pos = p as u64;
        Ok(self.pos)
    }
}

// ---------------------------------------------------------------------------

/// Лічильник прочитаних стиснених байтів (для прогресу).
struct Counting<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

impl<R: Seek> Seek for Counting<R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub found: HashMap<String, Row>,
    pub min_id: u64,
    pub max_id: u64,
    pub complete: bool,
}

fn leading_id(line: &[u8]) -> Option<u64> {
    let mut i = 0;
    if line.first() == Some(&b'"') {
        i = 1;
    }
    let mut id: u64 = 0;
    let mut digits = 0;
    while i < line.len() && line[i].is_ascii_digit() {
        id = id.wrapping_mul(10).wrapping_add((line[i] - b'0') as u64);
        digits += 1;
        i += 1;
    }
    (digits > 0).then_some(id)
}

/// Потоково переглядає documents.csv і повертає рядки для потрібних ID.
/// Зупиняється, щойно знайдено всі ID.
pub fn scan(path: &str, ids: &[String], cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<ScanResult, String> {
    let count = Arc::new(AtomicU64::new(0));
    let file = Counting { inner: File::open(path).map_err(|e| e.to_string())?, count: count.clone() };
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Не вдалося прочитати архів: {e}"))?;
    let name = find_entry(&archive, "documents.csv").ok_or("В архіві немає documents.csv")?;
    let entry = archive.by_name(&name).map_err(|e| e.to_string())?;
    let compressed = entry.compressed_size().max(1);
    let start = count.load(Ordering::Relaxed);

    let wanted: HashSet<u64> = ids.iter().filter_map(|s| s.trim().parse::<u64>().ok()).collect();
    let mut found: HashMap<String, Row> = HashMap::new();
    let mut reader = BufReader::with_capacity(1 << 20, entry);
    let mut line: Vec<u8> = Vec::with_capacity(1024);
    let mut columns: Option<Vec<String>> = None;
    let (mut min_id, mut max_id) = (u64::MAX, 0u64);
    let mut complete = true;
    let mut last_report = 0u64;

    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line).map_err(|e| format!("Помилка читання архіву: {e}"))?;
        if n == 0 {
            break;
        }
        let Some(cols) = &columns else {
            let header = String::from_utf8_lossy(&line);
            columns = Some(header.trim_start_matches('\u{feff}').trim().split('\t').map(unquote).collect());
            continue;
        };
        if let Some(id) = leading_id(&line) {
            min_id = min_id.min(id);
            max_id = max_id.max(id);
            if wanted.contains(&id) {
                let text = String::from_utf8_lossy(&line);
                let row: Row = cols.iter().cloned().zip(text.trim_end_matches(['\n', '\r']).split('\t').map(unquote)).collect();
                found.insert(id.to_string(), row);
                if found.len() >= wanted.len() {
                    complete = false;
                    break;
                }
            }
        }
        let read = count.load(Ordering::Relaxed) - start;
        if read - last_report > 2 << 20 {
            last_report = read;
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            progress((read as f64 / compressed as f64).min(1.0));
        }
    }
    progress(1.0);
    Ok(ScanResult { found, min_id: if min_id == u64::MAX { 0 } else { min_id }, max_id, complete })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sample_zip() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("court-analyzer-test-{}.zip", std::process::id()));
        let mut w = zip::ZipWriter::new(File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        w.start_file("courts.csv", opts).unwrap();
        w.write_all("court_code\tname\tinstance_code\tregion_code\n9901\t\"Верховний Суд\"\t1\t26\n".as_bytes()).unwrap();
        w.start_file("documents.csv", opts).unwrap();
        w.write_all(b"doc_id\tcourt_code\tjudgment_code\tcause_num\tdoc_url\n").unwrap();
        for i in 0..50_000u64 {
            writeln!(w, "{}\t9901\t2\t\"640/{}/25\"\thttps://od.example/{}.rtf", 100_000 + i, i, i).unwrap();
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn scans_tables_and_probe() {
        let path = sample_zip();
        let p = path.to_str().unwrap();
        let ids = vec!["100005".to_string(), "149999".to_string(), "7".to_string()];
        let r = scan(p, &ids, &AtomicBool::new(false), &|_| {}).unwrap();
        assert!(r.complete);
        assert_eq!(r.found.len(), 2);
        assert_eq!(r.found["100005"]["cause_num"], "640/5/25");
        assert_eq!((r.min_id, r.max_id), (100_000, 149_999));

        let early = scan(p, &ids[..1], &AtomicBool::new(false), &|_| {}).unwrap();
        assert!(!early.complete);

        let t = tables(p, &["courts.csv".to_string(), "regions.csv".to_string()]).unwrap();
        assert!(t["courts.csv"].contains("Верховний Суд"));
        assert!(!t.contains_key("regions.csv"));

        let head = probe(p).unwrap();
        assert!(head.starts_with("doc_id\t") && head.len() >= 200 * 1024);
        std::fs::remove_file(path).ok();
    }
}
