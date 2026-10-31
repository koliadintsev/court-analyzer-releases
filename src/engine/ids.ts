// Розпізнавання номерів рішень (doc_id) у файлах.
import { extractIdsFromText, uniqueIds as unique } from '../shared/ids';
import type { IdsParseResult } from '../shared/types';
import type { Platform } from './platform';

export { extractIdsFromText };

const ID_HEADERS = /^(doc_?id|id|№\s*рішення|номер\s*рішення|ідентифікатор|id\s*рішення|reg_?num)$/i;

function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('�') ? new TextDecoder('windows-1251').decode(bytes) : utf8;
}

function idsFromTable(rows: string[][]): string[] | undefined {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const col = rows[r].findIndex((c) => ID_HEADERS.test(String(c ?? '').trim()));
    if (col >= 0) {
      const values = rows
        .slice(r + 1)
        .map((row) => String(row[col] ?? '').trim())
        .flatMap((v) => extractIdsFromText(v));
      if (values.length) return unique(values);
    }
  }
  return undefined;
}

async function readXlsx(bytes: Uint8Array): Promise<{ rows: string[][]; links: string[] }[]> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheets: { rows: string[][]; links: string[] }[] = [];
  wb.eachSheet((ws) => {
    const sheet = { rows: [] as string[][], links: [] as string[] };
    ws.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value as unknown;
        if (v && typeof v === 'object' && 'hyperlink' in (v as object)) sheet.links.push(String((v as { hyperlink: string }).hyperlink));
        cells.push(cell.text ?? '');
      });
      sheet.rows.push(cells);
    });
    sheets.push(sheet);
  });
  return sheets;
}

export async function extractIdsFromFile(platform: Platform, filePath: string): Promise<IdsParseResult> {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const ext = /\.[^.]+$/.exec(fileName)?.[0].toLowerCase() ?? '';

  if (ext === '.xls') throw new Error('Формат .xls не підтримується — збережіть файл як .xlsx або .csv');
  const bytes = await platform.readBytes(filePath);
  if (ext === '.xlsx' || ext === '.xlsm') {
    // Беремо перший аркуш, на якому знайшлися номери: колонка з ID → посилання → текст.
    for (const { rows, links } of await readXlsx(bytes)) {
      const fromHeader = idsFromTable(rows);
      if (fromHeader) return { ids: fromHeader, fileName, note: 'ID взято з колонки з номерами рішень' };
      const fromLinks = extractIdsFromText(links.join('\n'));
      const ids = fromLinks.length ? fromLinks : extractIdsFromText(rows.map((r) => r.join(' ')).join('\n'));
      if (ids.length) return { ids, fileName };
    }
    return { ids: [], fileName };
  }

  const text = decodeText(bytes);
  if (ext === '.csv' || ext === '.tsv') {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const first = lines[0] ?? '';
    const delimiter = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
    const table = lines.map((l) => l.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, '')));
    const fromHeader = idsFromTable(table);
    if (fromHeader) return { ids: fromHeader, fileName, note: 'ID взято з колонки з номерами рішень' };
  }
  return { ids: extractIdsFromText(text), fileName };
}
