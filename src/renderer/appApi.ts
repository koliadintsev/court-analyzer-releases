// Зв'язка інтерфейсу з двигуном: реалізація Api поверх платформи Tauri.
import { createClient } from '../engine/ai';
import { Catalog } from '../engine/catalog';
import { buildRunWorkbook } from '../engine/excel';
import { errorText, isCancelled } from '../engine/http';
import { extractIdsFromFile } from '../engine/ids';
import { deleteRun, listRuns, loadRun, runPipeline } from '../engine/pipeline';
import type { Platform } from '../engine/platform';
import { SettingsStore } from '../engine/settings';
import { DataDir } from '../engine/storage';
import { TextStore } from '../engine/texts';
import { MODEL_SUGGESTIONS, TEMPLATES, newId } from '../shared/presets';
import type { IdsParseResult, ModelInfo, Profile, ProviderId, RunEvent } from '../shared/types';
import type { Api, CatalogProgress } from './api';
import type { Shell } from './platform-tauri';

const MODELS_MAX_AGE = 24 * 3600_000;
const PROFILE_FILTER = [{ name: 'Профіль CourtAnalyzer', extensions: ['json'] }];

export async function createAppApi(platform: Platform, shell: Shell, testMode = false): Promise<Api> {
  const dir = new DataDir(platform);
  const runListeners = new Set<(e: RunEvent) => void>();
  const progressListeners = new Set<(p: CatalogProgress) => void>();
  const emitRun = (e: RunEvent) => runListeners.forEach((l) => l(e));
  const emitProgress = (p: CatalogProgress) => progressListeners.forEach((l) => l(p));
  const logEvent = (level: 'info' | 'warn' | 'error', message: string) => emitRun({ type: 'log', level, message, time: new Date().toISOString() });

  const store = await SettingsStore.create(dir);
  const catalog = await Catalog.create(dir, logEvent);
  const texts = new TextStore(dir);
  let runAbort: AbortController | null = null;
  let downloadAbort: AbortController | null = null;

  const fetchModels = async (provider: ProviderId): Promise<ModelInfo[]> => {
    const client = createClient(provider, MODEL_SUGGESTIONS[provider][0] ?? '', {
      apiKey: store.getKey(provider) ?? '',
      baseUrl: provider === 'compatible' ? store.get().ai.compatibleBaseUrl : undefined,
      fetchFn: platform.fetch,
    });
    const models = await client.listModels();
    await store.setModels(provider, models);
    return models;
  };

  const parseFiles = async (paths: string[]): Promise<IdsParseResult> => {
    const ids: string[] = [];
    const notes: string[] = [];
    for (const p of paths) {
      const r = await extractIdsFromFile(platform, p);
      ids.push(...r.ids);
      notes.push(`${r.fileName}: ${r.ids.length}${r.note ? ` (${r.note})` : ''}`);
    }
    return { ids: [...new Set(ids)], fileName: paths.map((p) => p.split(/[\\/]/).pop()).join(', '), note: notes.join('; ') };
  };

  /** Скачує архів з показом прогресу на сторінці «Дані реєстру». */
  const withDownload = async (year: number, background: boolean, fn: (signal: AbortSignal) => Promise<unknown>) => {
    downloadAbort?.abort();
    const ctrl = new AbortController();
    downloadAbort = ctrl;
    try {
      await fn(ctrl.signal);
    } finally {
      if (downloadAbort === ctrl) downloadAbort = null;
      emitProgress({ year, done: 0, total: 0, finished: true, background });
    }
  };

  // Після запуску: щотижневе примусове оновлення завантажених архівів і списків моделей.
  setTimeout(async () => {
    try {
      await catalog.refreshIfStale(24);
      for (const year of await catalog.outdatedYears()) {
        if (runAbort) break; // під час обробки архіви оновлює сам конвеєр
        await withDownload(year, true, (signal) => catalog.ensureFresh(year, { signal, onProgress: (done, total) => emitProgress({ year, done, total, background: true }) }));
      }
    } catch (e) {
      if (!isCancelled(e)) logEvent('warn', `Автоматичне оновлення архівів: ${errorText(e)}`);
    }
  }, 3000);
  if (testMode) {
    // Лише для автоматичних перевірок (CA_TEST): експорт без діалогу збереження.
    Object.assign(window, {
      __caTest: {
        exportRunTo: async (id: string, path: string) => platform.writeBytes(path, await buildRunWorkbook((await loadRun(dir, id))!, await catalog.lookups())),
        route: async (ids: string[]) => Object.fromEntries((await catalog.route(ids)).byYear),
      },
    });
  }
  setTimeout(() => {
    for (const p of ['openai', 'anthropic', 'gemini'] as ProviderId[]) {
      if (store.getKey(p) && store.modelsAge(p) > MODELS_MAX_AGE) void fetchModels(p).catch(() => undefined);
    }
  }, 1500);

  return {
    async init() {
      return {
        settings: store.public(),
        profiles: store.getProfiles(),
        templates: TEMPLATES,
        models: store.modelLists(),
        dataDir: platform.dataDir,
        version: platform.version,
        running: runAbort !== null,
      };
    },
    updateSettings: (patch) => store.update(patch),
    setApiKey: (provider, key) => store.setKey(provider, key),
    async listModels(provider, refresh) {
      if (!store.getKey(provider) && provider !== 'compatible') return [];
      if (!refresh && store.modelsAge(provider) < MODELS_MAX_AGE) return store.modelLists()[provider] ?? [];
      return fetchModels(provider);
    },
    saveProfiles: (profiles) => store.saveProfiles(profiles),
    async exportProfile(profile) {
      const path = await shell.saveFile({ title: 'Експорт профілю аналізу', defaultPath: `${profile.name.replace(/[\\/:*?"<>|]/g, '_')}.json`, filters: PROFILE_FILTER });
      if (!path) return false;
      await platform.writeText(path, JSON.stringify({ format: 'court-analyzer-profile', version: 1, profile }, null, 2));
      return true;
    },
    async importProfile() {
      const [path] = await shell.pickFiles({ title: 'Імпорт профілю аналізу', filters: PROFILE_FILTER, multiple: false });
      if (!path) return null;
      const json = JSON.parse((await platform.readText(path)) ?? '{}');
      const profile: Profile = json.profile ?? json;
      if (!profile?.filters || !Array.isArray(profile.columns) || !profile.extraction) throw new Error('Файл не є профілем CourtAnalyzer');
      return { ...profile, id: newId('profile') };
    },
    async pickIdsFile() {
      const paths = await shell.pickFiles({
        title: 'Файл з переліком рішень',
        filters: [
          { name: 'Перелік рішень', extensions: ['txt', 'csv', 'tsv', 'xlsx', 'html', 'htm'] },
          { name: 'Усі файли', extensions: ['*'] },
        ],
        multiple: true,
      });
      return paths.length ? parseFiles(paths) : null;
    },
    parseIdsFiles: parseFiles,
    onFileDrop: (cb) => shell.onFileDrop(cb),

    async getCatalog(refresh) {
      if (refresh) await catalog.refresh();
      else await catalog.refreshIfStale(24).catch((e) => logEvent('warn', errorText(e)));
      return catalog.view();
    },
    async addCatalogUrl(input, year) {
      await catalog.addCustomUrl(input, year || undefined);
      return catalog.view();
    },
    async addCatalogFile(year) {
      const [path] = await shell.pickFiles({ title: 'Архів відкритих даних ЄДРСР', filters: [{ name: 'ZIP-архів', extensions: ['zip'] }], multiple: false });
      if (path) await catalog.addLocalFile(path, year || undefined);
      return catalog.view();
    },
    async removeCatalogSource(id) {
      await catalog.removeCustom(id);
      return catalog.view();
    },
    async deleteYearCache(year) {
      await catalog.deleteCache(year);
      return catalog.view();
    },
    async downloadYear(year) {
      await withDownload(year, false, async (signal) => {
        await catalog.download(year, { signal, onProgress: (done, total) => emitProgress({ year, done, total }) });
        await catalog.probe(year).catch(() => undefined);
      });
      return catalog.view();
    },
    async cancelDownload() {
      downloadAbort?.abort();
    },
    async clearTexts() {
      await texts.clear();
      return catalog.view();
    },

    async startRun(req) {
      if (runAbort) throw new Error('Обробка вже виконується');
      const ctrl = new AbortController();
      runAbort = ctrl;
      try {
        const run = await runPipeline(req, { dir, catalog, texts, settings: store.get(), getKey: (p) => store.getKey(p), emit: emitRun, signal: ctrl.signal });
        return run.id;
      } finally {
        runAbort = null;
      }
    },
    async stopRun() {
      runAbort?.abort();
    },
    listRuns: () => listRuns(dir),
    loadRun: (id) => loadRun(dir, id),
    deleteRun: (id) => deleteRun(dir, id),
    async exportRun(id) {
      const run = await loadRun(dir, id);
      if (!run) throw new Error('Результати запуску не знайдено');
      const docs = await shell.documentsDir().catch(() => '');
      const path = await shell.saveFile({
        title: 'Зберегти результати в Excel',
        defaultPath: platform.join(docs, `Судові рішення ${run.id}.xlsx`),
        filters: [{ name: 'Книга Excel', extensions: ['xlsx'] }],
      });
      if (!path) return null;
      await platform.writeBytes(path, await buildRunWorkbook(run, await catalog.lookups()));
      return path;
    },
    async getText(docId) {
      return (await texts.cached(docId)) ?? '';
    },
    openPath: (p) => shell.openPath(p),
    showItem: (p) => shell.reveal(p),
    async openExternal(url) {
      if (/^https?:\/\//i.test(url)) await shell.openUrl(url);
    },
    onRunEvent(cb) {
      runListeners.add(cb);
      return () => runListeners.delete(cb);
    },
    onCatalogProgress(cb) {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
  };
}
