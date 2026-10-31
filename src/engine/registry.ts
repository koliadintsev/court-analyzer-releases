// Відкриті дані ЄДРСР: розбір довідників і рядків documents.csv. Читання архівів — у Rust-шарі.
import type { Lookups, RegistryRow } from '../shared/types';
import { CancelledError } from './http';
import type { Platform } from './platform';

const DOC_COLUMNS: (keyof RegistryRow)[] = [
  'doc_id',
  'court_code',
  'judgment_code',
  'justice_kind',
  'category_code',
  'cause_num',
  'adjudication_date',
  'receipt_date',
  'judge',
  'doc_url',
  'status',
  'date_publ',
];

export const LOOKUP_TABLES = ['courts.csv', 'judgment_forms.csv', 'justice_kinds.csv', 'cause_categories.csv', 'regions.csv', 'instances.csv'];

/** Поле TSV без обрамлювальних лапок. */
function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
  return s;
}

export function parseTsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0].split('\t').map(unquote);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = lines[i].split('\t');
    const row: Record<string, string> = {};
    header.forEach((h, j) => (row[h] = unquote(cells[j] ?? '')));
    rows.push(row);
  }
  return rows;
}

export function lookupsFromTables(tables: Record<string, string>): Lookups {
  const table = (name: string) => (tables[name] ? parseTsv(tables[name]) : []);
  const toMap = (rows: Record<string, string>[], key: string) => Object.fromEntries(rows.map((r) => [r[key], r.name ?? '']));
  const courts: Lookups['courts'] = {};
  for (const r of table('courts.csv')) courts[r.court_code] = { name: r.name, instance: r.instance_code, region: r.region_code };
  return {
    courts,
    judgmentForms: toMap(table('judgment_forms.csv'), 'judgment_code'),
    justiceKinds: toMap(table('justice_kinds.csv'), 'justice_kind'),
    categories: toMap(table('cause_categories.csv'), 'category_code'),
    regions: toMap(table('regions.csv'), 'region_code'),
    instances: toMap(table('instances.csv'), 'instance_code'),
  };
}

export function mergeLookups(list: Lookups[]): Lookups {
  const out: Lookups = { courts: {}, judgmentForms: {}, justiceKinds: {}, categories: {}, regions: {}, instances: {} };
  for (const l of list) {
    for (const k of Object.keys(out) as (keyof Lookups)[]) Object.assign(out[k], l[k]);
  }
  return out;
}

/** Мінімальний doc_id за першими рядками documents.csv. */
export function minIdFromHead(head: string): number | undefined {
  const lines = head.split('\n').slice(1, -1);
  let min: number | undefined;
  for (const line of lines.slice(0, 3000)) {
    const id = Number(unquote(line.split('\t')[0]));
    if (Number.isFinite(id) && id > 0 && (min === undefined || id < min)) min = id;
  }
  return min;
}

export function toRegistryRow(raw: Record<string, string>): RegistryRow {
  const row = {} as RegistryRow;
  for (const c of DOC_COLUMNS) row[c] = raw[c] ?? '';
  return row;
}

export interface ScanResult {
  found: Map<string, RegistryRow>;
  minId: number;
  maxId: number;
  /** Чи прочитано файл до кінця (тоді maxId — справжній максимум року). */
  complete: boolean;
}

/** Шукає рядки для потрібних ID в архіві; зупиняється, щойно знайдено всі. */
export async function scanArchive(
  platform: Platform,
  path: string,
  ids: Iterable<string>,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<ScanResult> {
  if (opts.signal?.aborted) throw new CancelledError();
  const r = await platform.zipScan(path, [...ids], opts);
  return { found: new Map(Object.entries(r.found).map(([id, raw]) => [id, toRegistryRow(raw)])), minId: r.minId, maxId: r.maxId, complete: r.complete };
}
