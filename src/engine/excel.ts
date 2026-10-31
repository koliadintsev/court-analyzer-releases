// Експорт результатів запуску в Excel.
import type ExcelJS from 'exceljs';
import { INSTANCES, JUDGMENT_FORMS, JUSTICE_KINDS, META_COLUMNS, REVIEW_URL, STATUS_LABELS } from '../shared/registry';
import type { AiField, Column, DecisionRecord, Lookups, SavedRun } from '../shared/types';
import { metaValue } from './format';

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };

function columnTitle(c: Column): string {
  return c.kind === 'meta' ? META_COLUMNS[c.id].title : c.field.title;
}

function columnWidth(c: Column): number {
  if (c.kind === 'meta') {
    if (c.id === 'link') return 45;
    if (c.id === 'court' || c.id === 'category' || c.id === 'relevance_reason') return 40;
    if (c.id === 'judge') return 28;
    return 16;
  }
  if (c.field.type === 'long_text') return 80;
  if (c.field.type === 'list') return 40;
  if (c.field.type === 'boolean' || c.field.type === 'number' || c.field.type === 'date') return 16;
  return 30;
}

function aiValue(field: AiField, record: DecisionRecord): string | number {
  const v = record.data?.[field.id];
  if (Array.isArray(v)) return v.join('; ');
  const s = v === undefined || v === null ? '' : String(v);
  if (field.type === 'number') {
    const n = Number(s.replace(/\s/g, '').replace(',', '.'));
    if (s && Number.isFinite(n)) return n;
  }
  return s;
}

function styleHeader(ws: ExcelJS.Worksheet): void {
  const header = ws.getRow(1);
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  header.height = 30;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

function setLink(cell: ExcelJS.Cell, url: string): void {
  cell.value = { text: url, hyperlink: url };
  cell.font = { color: { argb: 'FF1155CC' }, underline: true };
}

/** Формує книгу Excel з результатами запуску. */
export async function buildRunWorkbook(run: SavedRun, lookups: Lookups): Promise<Uint8Array> {
  const { default: Excel } = await import('exceljs');
  const wb = new Excel.Workbook();
  wb.creator = 'CourtAnalyzer';
  wb.created = new Date();
  const columns = run.profile.columns.filter((c) => c.enabled);

  // Аркуш 1: результати
  const ws = wb.addWorksheet('Результати');
  ws.columns = columns.map((c) => ({ header: columnTitle(c), width: columnWidth(c) }));
  const done = run.records.filter((r) => r.status === 'done');
  for (const rec of done) {
    const row = ws.addRow(
      columns.map((c) => {
        if (c.kind === 'ai') return aiValue(c.field, rec);
        return c.id === 'link' ? '' : metaValue(c.id, rec, lookups) ?? '';
      }),
    );
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.alignment = { vertical: 'top', wrapText: true };
      const v = cell.value;
      if (v instanceof Date) cell.numFmt = 'dd.mm.yyyy';
      if (c.kind === 'meta' && c.id === 'link') setLink(cell, REVIEW_URL + rec.docId);
    });
  }
  styleHeader(ws);

  // Аркуш 2: відхилені та помилки
  const rej = wb.addWorksheet('Відхилені');
  rej.columns = [
    { header: 'ID рішення', width: 14 },
    { header: 'Номер справи', width: 18 },
    { header: 'Дата рішення', width: 14 },
    { header: 'Суд', width: 40 },
    { header: 'Форма рішення', width: 16 },
    { header: 'Статус', width: 28 },
    { header: 'Причина', width: 80 },
    { header: 'Посилання', width: 45 },
  ];
  for (const rec of run.records.filter((r) => r.status !== 'done')) {
    const row = rej.addRow([
      rec.docId,
      rec.meta?.cause_num ?? '',
      metaValue('adjudication_date', rec, lookups) ?? '',
      rec.meta ? metaValue('court', rec, lookups) : '',
      rec.meta ? metaValue('judgment_form', rec, lookups) : '',
      STATUS_LABELS[rec.status],
      rec.reason ?? '',
      '',
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    if (row.getCell(3).value instanceof Date) row.getCell(3).numFmt = 'dd.mm.yyyy';
    setLink(row.getCell(8), REVIEW_URL + rec.docId);
  }
  styleHeader(rej);

  // Аркуш 3: параметри запуску
  const par = wb.addWorksheet('Параметри');
  par.columns = [
    { header: 'Параметр', width: 34 },
    { header: 'Значення', width: 100 },
  ];
  const f = run.profile.filters;
  const names = (codes: string[], dict: Record<string, string>) => (codes.length ? codes.map((c) => dict[c] ?? c).join(', ') : 'усі');
  const counts = run.summary?.counts ?? {};
  const rows: [string, string][] = [
    ['Дата запуску', new Date(run.startedAt).toLocaleString('uk-UA')],
    ['Профіль аналізу', run.profile.name],
    ['Рішень у переліку', String(run.records.length)],
    ...Object.entries(counts).map(([k, v]) => [`— ${STATUS_LABELS[k as keyof typeof STATUS_LABELS]}`, String(v)] as [string, string]),
    ['Форми рішення', names(f.judgmentForms, JUDGMENT_FORMS)],
    ['Види судочинства', names(f.justiceKinds, JUSTICE_KINDS)],
    ['Інстанції', names(f.instances, INSTANCES)],
    ['Період ухвалення', `${f.dateFrom || '…'} — ${f.dateTo || '…'}`],
    ['Мінімальна довжина тексту', String(f.minTextLength)],
    ['ШІ-фільтр', run.models.filter ? `${run.models.filter.provider} / ${run.models.filter.model}` : 'вимкнено'],
    ['Критерій ШІ-фільтра', run.models.filter ? f.aiCriterion : '—'],
    ['Модель для витягу даних', run.models.extract ? `${run.models.extract.provider} / ${run.models.extract.model}` : 'вимкнено'],
    ...run.profile.columns.flatMap((c) => (c.kind === 'ai' && c.enabled ? [[`Поле «${c.field.title}»`, c.field.instruction] as [string, string]] : [])),
  ];
  if (run.error) rows.push(['Помилка', run.error]);
  if (run.summary?.cancelled) rows.push(['Увага', 'Обробку було зупинено до завершення']);
  rows.forEach((r) => (par.addRow(r).alignment = { vertical: 'top', wrapText: true }));
  styleHeader(par);

  return new Uint8Array(await wb.xlsx.writeBuffer());
}
