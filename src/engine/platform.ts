// Можливості середовища, потрібні двигуну. Реалізація для програми — src/renderer/platform-tauri.ts
// (Rust-шар Tauri), у тестах — імітація.
import type { FetchFn } from './http';

export interface ScanRows {
  found: Record<string, Record<string, string>>;
  minId: number;
  maxId: number;
  complete: boolean;
}

export interface DownloadResult {
  status: number;
  etag?: string | null;
  lastModified?: string | null;
  size: number;
  total?: number | null;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

export interface Platform {
  fetch: FetchFn;
  dataDir: string;
  version: string;
  /** Чи шифруються API-ключі засобами ОС. */
  encryption: boolean;
  join(...parts: string[]): string;
  readText(path: string): Promise<string | undefined>;
  /** Атомарний запис; батьківські папки створюються автоматично. */
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** Видаляє файл або папку в робочій папці (відсутній шлях — не помилка). */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  listDir(path: string): Promise<string[]>;
  dirStats(path: string): Promise<{ files: number; bytes: number }>;
  zipEntries(path: string): Promise<string[]>;
  zipTables(path: string, names: string[]): Promise<Record<string, string>>;
  /** Початок documents.csv з локального архіву або за URL (через HTTP Range). */
  zipProbe(source: string): Promise<string>;
  zipScan(path: string, ids: string[], opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<ScanRows>;
  download(
    url: string,
    dest: string,
    opts?: { resumeFrom?: number; ifRange?: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
  ): Promise<DownloadResult>;
  protect(text: string): Promise<string>;
  unprotect(value: string): Promise<string>;
}
