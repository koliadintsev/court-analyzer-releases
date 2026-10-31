// Значення колонок метаданих для таблиці результатів.
import { INSTANCES, JUDGMENT_FORMS, JUSTICE_KINDS, REVIEW_URL } from '../shared/registry';
import type { DecisionRecord, Lookups, MetaColumnId } from '../shared/types';

/** Дата з поля відкритих даних ("2025-12-30 00:00:00+02") як Date (UTC-північ) або undefined. */
export function parseRegistryDate(v: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
}

export function formatDate(d: Date | undefined): string {
  if (!d) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

export function instanceCode(record: DecisionRecord, lookups: Lookups): string | undefined {
  const court = record.meta && lookups.courts[record.meta.court_code];
  return court?.instance;
}

export function metaValue(id: MetaColumnId, record: DecisionRecord, lookups: Lookups): string | Date | undefined {
  const m = record.meta;
  switch (id) {
    case 'doc_id':
      return record.docId;
    case 'link':
      return REVIEW_URL + record.docId;
    case 'relevance_reason':
      return record.relevance?.reason ?? '';
    default:
      break;
  }
  if (!m) return '';
  switch (id) {
    case 'adjudication_date':
      return parseRegistryDate(m.adjudication_date);
    case 'receipt_date':
      return parseRegistryDate(m.receipt_date);
    case 'date_publ':
      return parseRegistryDate(m.date_publ);
    case 'cause_num':
      return m.cause_num;
    case 'judge':
      return m.judge;
    case 'court':
      return lookups.courts[m.court_code]?.name ?? m.court_code;
    case 'instance': {
      const code = instanceCode(record, lookups);
      return code ? INSTANCES[code] ?? lookups.instances[code] ?? code : 'Невідомо';
    }
    case 'judgment_form':
      return lookups.judgmentForms[m.judgment_code] ?? JUDGMENT_FORMS[m.judgment_code] ?? m.judgment_code;
    case 'justice_kind':
      return lookups.justiceKinds[m.justice_kind] ?? JUSTICE_KINDS[m.justice_kind] ?? m.justice_kind;
    case 'category':
      return lookups.categories[m.category_code] ?? m.category_code;
    case 'region': {
      const r = lookups.courts[m.court_code]?.region;
      return r ? lookups.regions[r] ?? r : '';
    }
  }
}
