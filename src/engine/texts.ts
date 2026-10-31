// Завантаження текстів рішень за посиланням doc_url з відкритих даних і кешування на диску.
import type { RegistryRow } from '../shared/types';
import { fetchWithRetry } from './http';
import { htmlToText, latin1, rtfToText } from './rtf';
import type { DataDir } from './storage';

export function decodeDocument(bytes: Uint8Array): string {
  if (latin1(bytes.subarray(0, 32)).includes('{\\rtf')) return rtfToText(bytes);
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const text = utf8.includes('�') ? new TextDecoder('windows-1251').decode(bytes) : utf8;
  return /<html|<body|<div/i.test(text.slice(0, 2000)) ? htmlToText(text) : text.trim();
}

export class TextStore {
  constructor(private dir: DataDir) {}

  private file(docId: string): string {
    return this.dir.path('texts', `${docId}.txt`);
  }

  cached(docId: string): Promise<string | undefined> {
    return this.dir.platform.readText(this.file(docId));
  }

  async get(row: RegistryRow, signal?: AbortSignal): Promise<string> {
    const hit = await this.cached(row.doc_id);
    if (hit !== undefined) return hit;
    if (!row.doc_url) throw new Error('у відкритих даних немає посилання на текст');
    const url = row.doc_url.replace(/^http:\/\//i, 'https://');
    const res = await fetchWithRetry(this.dir.platform.fetch, url, {}, { signal, retries: 3, baseDelayMs: 2000 });
    const text = decodeDocument(new Uint8Array(await res.arrayBuffer()));
    if (text) await this.dir.platform.writeText(this.file(row.doc_id), text);
    return text;
  }

  clear(): Promise<void> {
    return this.dir.remove('texts');
  }
}
