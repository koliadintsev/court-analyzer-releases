import type { MetaColumnId, RecordStatus } from './types';

// Довідники відкритих даних ЄДРСР (стан на 2026 рік). Актуальні назви
// програма також читає з архіву, але ці значення потрібні інтерфейсу одразу.

export const JUDGMENT_FORMS: Record<string, string> = {
  '1': 'Вирок',
  '2': 'Постанова',
  '3': 'Рішення',
  '4': 'Судовий наказ',
  '5': 'Ухвала',
  '6': 'Окрема ухвала',
  '7': 'Додаткове рішення',
  '10': 'Окрема думка',
};

export const JUSTICE_KINDS: Record<string, string> = {
  '1': 'Цивільне',
  '2': 'Кримінальне',
  '3': 'Господарське',
  '4': 'Адміністративне',
  '5': 'Адмінправопорушення',
};

export const INSTANCES: Record<string, string> = {
  '1': 'Касація',
  '2': 'Апеляція',
  '3': 'Перша інстанція',
};

export const META_COLUMNS: Record<MetaColumnId, { title: string; hint: string }> = {
  adjudication_date: { title: 'Дата рішення', hint: 'Дата ухвалення рішення' },
  cause_num: { title: 'Номер справи', hint: 'Єдиний унікальний номер справи' },
  court: { title: 'Суд', hint: 'Назва суду' },
  instance: { title: 'Інстанція', hint: 'Касація / апеляція / перша інстанція' },
  judgment_form: { title: 'Форма рішення', hint: 'Постанова, рішення, ухвала…' },
  justice_kind: { title: 'Вид судочинства', hint: 'Адміністративне, господарське…' },
  category: { title: 'Категорія справи', hint: 'Категорія за класифікатором реєстру' },
  judge: { title: 'Суддя', hint: 'Головуючий суддя' },
  region: { title: 'Регіон', hint: 'Регіон суду' },
  receipt_date: { title: 'Дата надходження', hint: 'Дата надходження рішення до реєстру' },
  date_publ: { title: 'Дата оприлюднення', hint: 'Дата оприлюднення в реєстрі' },
  doc_id: { title: 'ID рішення', hint: 'Номер рішення в ЄДРСР' },
  link: { title: 'Посилання', hint: 'Посилання на рішення в ЄДРСР' },
  relevance_reason: { title: 'Чому релевантне (ШІ)', hint: 'Пояснення ШІ-фільтра' },
};

export const REVIEW_URL = 'https://reyestr.court.gov.ua/Review/';

export const STATUS_LABELS: Record<RecordStatus, string> = {
  pending: 'Очікує',
  not_found: 'Не знайдено у відкритих даних',
  filtered_meta: 'Відсіяно формальними фільтрами',
  no_text: 'Немає тексту',
  too_short: 'Закороткий текст',
  irrelevant: 'Не стосується теми',
  relevant: 'Релевантне',
  done: 'Оброблено',
  error: 'Помилка',
};
