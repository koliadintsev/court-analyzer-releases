// Спільні типи для головного процесу (двигуна) та інтерфейсу.

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'compatible';

export interface StageModel {
  provider: ProviderId;
  model: string;
}

export interface AiSettings {
  filter: StageModel;
  extract: StageModel;
  /** Кількість паралельних запитів до ШІ. */
  concurrency: number;
  /** Максимальна кількість символів тексту рішення в одному запиті. */
  maxInputChars: number;
  /** Base URL для OpenAI-сумісного провайдера (OpenRouter, Ollama, LM Studio…). */
  compatibleBaseUrl: string;
}

export interface AppSettings {
  ai: AiSettings;
  /** Кількість паралельних завантажень текстів рішень. */
  textConcurrency: number;
  activeProfileId: string;
  /** Шаблони, профілі з яких уже додавалися автоматично (щоб не додавати повторно після видалення). */
  seededTemplates?: string[];
}

/** Налаштування, які бачить інтерфейс (без самих ключів). */
export interface PublicSettings extends AppSettings {
  keys: Record<ProviderId, boolean>;
  keysEncrypted: boolean;
}

// ---------------------------------------------------------------------------
// Профіль аналізу: фільтри + поля таблиці + інструкції для ШІ

export type FieldType = 'text' | 'long_text' | 'list' | 'boolean' | 'number' | 'date' | 'enum';

export interface AiField {
  /** Ключ поля в JSON-відповіді ШІ (латиниця). */
  id: string;
  /** Назва колонки в таблиці. */
  title: string;
  /** Інструкція для ШІ: що саме треба знайти. */
  instruction: string;
  type: FieldType;
  /** Допустимі значення для типу enum. */
  options?: string[];
}

export type MetaColumnId =
  | 'adjudication_date'
  | 'cause_num'
  | 'court'
  | 'instance'
  | 'judgment_form'
  | 'justice_kind'
  | 'category'
  | 'judge'
  | 'region'
  | 'receipt_date'
  | 'date_publ'
  | 'doc_id'
  | 'link'
  | 'relevance_reason';

export type Column =
  | { kind: 'meta'; id: MetaColumnId; enabled: boolean }
  | { kind: 'ai'; enabled: boolean; field: AiField };

export interface ProfileFilters {
  /** Коди форм рішення (judgment_code). Порожньо — всі. */
  judgmentForms: string[];
  /** Коди видів судочинства (justice_kind). Порожньо — всі. */
  justiceKinds: string[];
  /** Коди інстанцій (1 — касація, 2 — апеляція, 3 — перша). Порожньо — всі. */
  instances: string[];
  /** Дата ухвалення рішення від/до (YYYY-MM-DD). */
  dateFrom: string;
  dateTo: string;
  /** Мінімальна довжина тексту рішення (символів). */
  minTextLength: number;
  aiFilterEnabled: boolean;
  /** Опис теми, якій має відповідати рішення. */
  aiCriterion: string;
  /** Додаткові вказівки для ШІ-фільтра. */
  aiFilterInstructions: string;
}

export interface ProfileExtraction {
  enabled: boolean;
  /** Роль аналітика (перше речення системного промпту). */
  role: string;
  /** Загальні вказівки для витягу даних. */
  instructions: string;
  /** Що писати, якщо даних немає. */
  unknownValue: string;
}

export interface Profile {
  id: string;
  name: string;
  /** Ідентифікатор шаблону, з якого створено профіль. */
  templateId?: string;
  filters: ProfileFilters;
  extraction: ProfileExtraction;
  columns: Column[];
}

// ---------------------------------------------------------------------------
// Реєстр

/** Рядок documents.csv з відкритих даних ЄДРСР. */
export interface RegistryRow {
  doc_id: string;
  court_code: string;
  judgment_code: string;
  justice_kind: string;
  category_code: string;
  cause_num: string;
  adjudication_date: string;
  receipt_date: string;
  judge: string;
  doc_url: string;
  status: string;
  date_publ: string;
}

export interface Lookups {
  courts: Record<string, { name: string; instance: string; region: string }>;
  judgmentForms: Record<string, string>;
  justiceKinds: Record<string, string>;
  categories: Record<string, string>;
  regions: Record<string, string>;
  instances: Record<string, string>;
}

export type SourceOrigin = 'dsa' | 'data.gov.ua' | 'builtin' | 'custom' | 'file';

export interface DatasetSource {
  url: string;
  origin: SourceOrigin;
  /** Розмір архіву за даними джерела (байт), якщо відомий. */
  size?: number;
}

export interface YearView {
  year: number;
  sources: DatasetSource[];
  minId?: number;
  maxIdSeen?: number;
  cache?: {
    size: number;
    downloadedAt: string;
    /** Коли востаннє звіряли з сервером. */
    checkedAt?: string;
    /** true, якщо архів обрано з диска (не завантажувався програмою). */
    local: boolean;
    path: string;
  };
}

export interface CustomSourceEntry {
  id: string;
  year: number;
  url: string;
  origin: 'custom' | 'file';
  label: string;
}

export interface CatalogView {
  years: YearView[];
  updatedAt?: string;
  warnings: string[];
  custom: CustomSourceEntry[];
  dataDir: string;
  textCache: { files: number; bytes: number };
}

// ---------------------------------------------------------------------------
// Запуск

export type RecordStatus =
  | 'pending'
  | 'not_found'
  | 'filtered_meta'
  | 'no_text'
  | 'too_short'
  | 'irrelevant'
  | 'relevant'
  | 'done'
  | 'error';

export interface DecisionRecord {
  docId: string;
  year?: number;
  meta?: RegistryRow;
  textLength?: number;
  status: RecordStatus;
  /** Пояснення статусу (чому відхилено, текст помилки тощо). */
  reason?: string;
  relevance?: { relevant: boolean; reason: string };
  data?: Record<string, unknown>;
}

export type StageId = 'registry' | 'texts' | 'filter' | 'extract' | 'export';

export interface RunSummary {
  total: number;
  counts: Partial<Record<RecordStatus, number>>;
  startedAt: string;
  finishedAt: string;
  cancelled: boolean;
}

export type RunEvent =
  | { type: 'stage'; stage: StageId; label: string }
  | { type: 'progress'; stage: StageId; done: number; total: number; detail?: string; unit?: 'items' | 'bytes' | 'fraction' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; time: string }
  | { type: 'record'; record: DecisionRecord }
  | { type: 'finished'; summary: RunSummary; runId: string }
  | { type: 'failed'; message: string };

export interface RunRequest {
  ids: string[];
  profile: Profile;
}

export interface SavedRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  profile: Profile;
  models: { filter?: StageModel; extract?: StageModel };
  records: DecisionRecord[];
  summary?: RunSummary;
  error?: string;
}

export interface RunInfo {
  id: string;
  startedAt: string;
  finishedAt?: string;
  profileName: string;
  total: number;
  done: number;
  counts: Partial<Record<RecordStatus, number>>;
  cancelled: boolean;
  error?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Швидка й недорога модель (для фільтра). */
  light: boolean;
}

export interface IdsParseResult {
  ids: string[];
  fileName?: string;
  note?: string;
}
