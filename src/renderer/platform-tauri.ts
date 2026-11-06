// Реалізація платформи через Rust-шар Tauri (src-tauri) та його плагіни.
import { Channel, invoke } from '@tauri-apps/api/core';
import { documentDir, sep } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save } from '@tauri-apps/plugin-dialog';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { CancelledError } from '../engine/http';
import type { DownloadResult, FileStat, Platform, ScanRows } from '../engine/platform';

export interface Shell {
  pickFiles(opts: { title: string; filters: { name: string; extensions: string[] }[]; multiple: boolean }): Promise<string[]>;
  saveFile(opts: { title: string; defaultPath: string; filters: { name: string; extensions: string[] }[] }): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  documentsDir(): Promise<string>;
  onFileDrop(cb: (paths: string[]) => void): () => void;
}

let opCounter = 0;

/** Довгі операції Rust можна скасувати за ідентифікатором. */
async function cancellable<T>(signal: AbortSignal | undefined, run: (op: string) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new CancelledError();
  const op = `op-${Date.now()}-${++opCounter}`;
  const onAbort = () => void invoke('cancel_op', { op });
  signal?.addEventListener('abort', onAbort);
  try {
    return await run(op);
  } catch (e) {
    if (signal?.aborted || String(e) === 'cancelled') throw new CancelledError();
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function b64utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

export async function createTauriPlatform(): Promise<{ platform: Platform; shell: Shell; testMode: boolean }> {
  const info = await invoke<{ dataDir: string; version: string; encryption: boolean; testMode: boolean }>('app_info');
  const pathSep = sep();
  const call = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw asError(e);
    }
  };

  const platform: Platform = {
    // Порожній Origin: деякі сервери (зокрема локальні ШІ) відхиляють запити з чужим Origin.
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('origin')) headers.set('Origin', '');
      return tauriFetch(url, { ...init, headers });
    },
    dataDir: info.dataDir,
    version: info.version,
    encryption: info.encryption,
    // Windows: «\» (і «/» теж зводимо до «\»); macOS: «/».
    join: (...parts) => parts.filter(Boolean).join(pathSep).replace(pathSep === '\\' ? /[\\/]+/g : /\/+/g, pathSep),
    readText: async (path) => (await call<string | null>('read_text', { path })) ?? undefined,
    writeText: (path, text) => call('write_text', { path, text }),
    readBytes: async (path) => new Uint8Array(await call<ArrayBuffer>('read_bytes', { path })),
    writeBytes: (path, data) => invoke<void>('write_bytes', data, { headers: { 'x-path': b64utf8(path) } }).catch((e) => Promise.reject(asError(e))),
    remove: (path) => call('remove_path', { path }),
    rename: (from, to) => call('rename_path', { from, to }),
    stat: async (path) => (await call<FileStat | null>('stat_path', { path })) ?? undefined,
    listDir: (path) => call('list_dir', { path }),
    dirStats: (path) => call('dir_stats', { path }),
    zipEntries: (path) => call('zip_entries', { path }),
    zipTables: (path, names) => call('zip_tables', { path, names }),
    zipProbe: (source) => call('zip_probe', { source }),
    zipScan: (path, ids, opts = {}) =>
      cancellable(opts.signal, (op) => {
        const onProgress = new Channel<number>();
        onProgress.onmessage = (f) => opts.onProgress?.(f);
        return invoke<ScanRows>('zip_scan', { path, ids, op, onProgress });
      }),
    download: (url, dest, opts = {}) =>
      cancellable(opts.signal, (op) => {
        const onProgress = new Channel<[number, number]>();
        onProgress.onmessage = ([d, t]) => opts.onProgress?.(d, t);
        return invoke<DownloadResult>('download_file', { url, dest, resumeFrom: opts.resumeFrom ?? 0, ifRange: opts.ifRange ?? null, op, onProgress });
      }),
    protect: (text) => call('protect', { text }),
    unprotect: (value) => call('unprotect', { value }),
  };

  const shell: Shell = {
    async pickFiles({ title, filters, multiple }) {
      const r = await open({ title, filters, multiple, directory: false });
      return r === null ? [] : Array.isArray(r) ? r : [r];
    },
    saveFile: ({ title, defaultPath, filters }) => save({ title, defaultPath, filters }),
    openUrl: (url) => openUrl(url),
    openPath: (path) => openPath(path),
    reveal: (path) => revealItemInDir(path),
    documentsDir: () => documentDir(),
    onFileDrop(cb) {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type === 'drop' && e.payload.paths.length) cb(e.payload.paths);
        })
        .then((u) => (disposed ? u() : (unlisten = u)));
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
  return { platform, shell, testMode: info.testMode };
}
