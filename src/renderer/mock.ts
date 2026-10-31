// Імітація головного процесу для перегляду інтерфейсу у звичайному браузері (лише `npm run dev:ui`).
import { DEFAULT_SETTINGS, TEMPLATES, profileFromTemplate } from '../shared/presets';
import type { CatalogView, DecisionRecord, ModelInfo, Profile, PublicSettings, RunEvent, SavedRun } from '../shared/types';
import type { Api } from './api';

const listeners = new Set<(e: RunEvent) => void>();
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-flash-latest', name: 'Gemini Flash Latest', light: true },
  { id: 'gemini-flash-lite-latest', name: 'Gemini Flash-Lite Latest', light: true },
  { id: 'gemini-pro-latest', name: 'Gemini Pro Latest', light: false },
];
let settings: PublicSettings = { ...DEFAULT_SETTINGS, keys: { openai: false, anthropic: true, gemini: true, compatible: false }, keysEncrypted: true };
let profiles: Profile[] = [profileFromTemplate(TEMPLATES[0])];
settings.activeProfileId = profiles[0].id;
let lastRun: SavedRun | undefined;

const catalog: CatalogView = {
  years: [2026, 2025, 2024, 2023].map((year) => ({
    year,
    sources: [
      { url: `https://court.gov.ua/storage/portal/open_data_files/${year}.zip`, origin: 'dsa' as const },
      { url: `https://data.gov.ua/dataset/x/edrsr_data_${year}.zip`, origin: 'data.gov.ua' as const, size: 332e6 },
    ],
    minId: year === 2026 ? 133050997 : year === 2025 ? 124175906 : undefined,
    cache: year === 2026 ? { size: 332023239, downloadedAt: new Date().toISOString(), local: false, path: 'C:\\CourtAnalyzer-data\\registry\\edrsr_data_2026.zip' } : undefined,
  })),
  updatedAt: new Date().toISOString(),
  warnings: [],
  custom: [],
  dataDir: 'C:\\CourtAnalyzer\\CourtAnalyzer-data',
  textCache: { files: 42, bytes: 1_250_000 },
};

const emit = (e: RunEvent) => listeners.forEach((l) => l(e));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const mockApi: Api = {
  async init() {
    return { settings, profiles, templates: TEMPLATES, models: { gemini: GEMINI_MODELS, anthropic: [] }, dataDir: catalog.dataDir, version: '1.0.0-dev', running: false };
  },
  async updateSettings(patch) {
    settings = { ...settings, ...patch, ai: { ...settings.ai, ...(patch.ai ?? {}) } };
    return settings;
  },
  async setApiKey(provider, key) {
    settings = { ...settings, keys: { ...settings.keys, [provider]: Boolean(key) } };
    return settings;
  },
  async listModels(provider) {
    await wait(400);
    return provider === 'gemini' ? GEMINI_MODELS : [{ id: 'model-a', name: 'Model A', light: true }, { id: 'model-b', name: 'Model B', light: false }];
  },
  async saveProfiles(p) {
    profiles = p;
  },
  async exportProfile() {
    return true;
  },
  async importProfile() {
    return null;
  },
  async pickIdsFile() {
    return { ids: ['133055529', '133055535', '133055541'], fileName: 'results.html', note: 'results.html: 3' };
  },
  async parseIdsFiles() {
    return { ids: ['133055529'], fileName: 'x.txt' };
  },
  onFileDrop: () => () => undefined,
  async getCatalog() {
    return catalog;
  },
  async addCatalogUrl() {
    return catalog;
  },
  async addCatalogFile() {
    return catalog;
  },
  async removeCatalogSource() {
    return catalog;
  },
  async deleteYearCache() {
    return catalog;
  },
  async downloadYear() {
    return catalog;
  },
  async cancelDownload() {},
  async clearTexts() {
    return catalog;
  },
  async startRun(req) {
    const records: DecisionRecord[] = req.ids.map((id) => ({ docId: id, status: 'pending' }));
    const t = () => new Date().toISOString();
    emit({ type: 'stage', stage: 'registry', label: 'Пошук рішень у відкритих даних реєстру' });
    emit({ type: 'log', level: 'info', message: `Рішень у переліку: ${records.length}`, time: t() });
    for (let i = 0; i <= 10; i++) {
      emit({ type: 'progress', stage: 'registry', done: i * 100, total: 1000, detail: 'Пошук в архіві за 2026 рік' });
      await wait(60);
    }
    records.forEach((r, i) => {
      r.meta = {
        doc_id: r.docId, court_code: '9901', judgment_code: i % 3 ? '2' : '5', justice_kind: '4', category_code: '', cause_num: `640/${1000 + i}/25`,
        adjudication_date: '2026-03-1' + (i % 9) + ' 00:00:00+02', receipt_date: '', judge: 'Суддя', doc_url: 'x', status: '1', date_publ: '',
      };
    });
    emit({ type: 'stage', stage: 'texts', label: 'Завантаження текстів рішень' });
    for (let i = 0; i < records.length; i++) {
      records[i].textLength = 12000 + i * 1000;
      emit({ type: 'progress', stage: 'texts', done: i + 1, total: records.length });
      emit({ type: 'record', record: { ...records[i] } });
      await wait(40);
    }
    emit({ type: 'stage', stage: 'filter', label: 'ШІ-фільтр за темою (gemini-flash-latest)' });
    for (let i = 0; i < records.length; i++) {
      const relevant = i % 3 !== 2;
      Object.assign(records[i], { status: relevant ? 'relevant' : 'irrelevant', relevance: { relevant, reason: relevant ? 'Спір щодо стягнення неустойки за договором поставки.' : 'Рішення стосується митних платежів.' }, reason: relevant ? undefined : 'Рішення стосується митних платежів.' });
      emit({ type: 'record', record: { ...records[i] } });
      emit({ type: 'progress', stage: 'filter', done: i + 1, total: records.length });
      await wait(80);
    }
    emit({ type: 'stage', stage: 'extract', label: 'Витяг даних (gemini-pro-latest)' });
    const rel = records.filter((r) => r.status === 'relevant');
    for (let i = 0; i < rel.length; i++) {
      Object.assign(rel[i], {
        status: 'done',
        data: {
          claimant: 'ТОВ «Агро Експорт»', defendant: 'ТОВ «Зернотрейд»', subject: 'стягнення неустойки за договором поставки', claim_amount: 1250000,
          outcome: 'задоволено частково', winner: 'частково', legal_norms: ['ст. 549 ЦК України', 'ст. 231 ГК України'], legal_position: 'невідомо',
          summary: 'Позивач просив стягнути неустойку за прострочення поставки…', keywords: ['поставка', 'неустойка', 'прострочення'],
        },
      });
      emit({ type: 'record', record: { ...rel[i] } });
      emit({ type: 'progress', stage: 'extract', done: i + 1, total: rel.length });
      await wait(120);
    }
    lastRun = { id: 'mock', startedAt: t(), profile: req.profile, models: {}, records };
    const counts: Record<string, number> = {};
    records.forEach((r) => (counts[r.status] = (counts[r.status] ?? 0) + 1));
    emit({ type: 'finished', runId: 'mock', summary: { total: records.length, counts, startedAt: t(), finishedAt: t(), cancelled: false } });
    return 'mock';
  },
  async stopRun() {},
  async listRuns() {
    return lastRun ? [{ id: lastRun.id, startedAt: lastRun.startedAt, finishedAt: new Date().toISOString(), profileName: lastRun.profile.name, total: lastRun.records.length, done: 2, counts: { done: 2, irrelevant: 1 }, cancelled: false }] : [];
  },
  async loadRun() {
    return lastRun;
  },
  async deleteRun() {
    lastRun = undefined;
  },
  async exportRun() {
    return 'C:\\Users\\user\\Documents\\results.xlsx';
  },
  async getText() {
    return 'ВЕРХОВНИЙ СУД\nПОСТАНОВА\nІМЕНЕМ УКРАЇНИ\n…';
  },
  async openPath() {},
  async showItem() {},
  async openExternal(url) {
    window.open(url, '_blank');
  },
  onRunEvent(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  onCatalogProgress() {
    return () => undefined;
  },
};
