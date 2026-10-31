// Каталог річних наборів відкритих даних ЄДРСР: пошук посилань, визначення
// діапазонів ID, завантаження, щотижневе оновлення і кешування архівів.
import type { CatalogView, CustomSourceEntry, DatasetSource, Lookups, YearView } from '../shared/types';
import { newId } from '../shared/presets';
import { CancelledError, errorText, fetchJson, fetchWithRetry, isCancelled } from './http';
import type { Platform } from './platform';
import { LOOKUP_TABLES, lookupsFromTables, mergeLookups, minIdFromHead } from './registry';
import type { DataDir } from './storage';

const CKAN = 'https://data.gov.ua/api/3/action';
const DSA_ORG = 'derzhavna-sudova-administratsiia-ukrayiny';
const DSA_PASSPORT = 'https://dsa.court.gov.ua/open_data_json.php?json=';

/** Відомі паспорти наборів на сайті ДСА (dsa.court.gov.ua/dsa/inshe/oddata/<id>/). */
const DSA_PASSPORT_IDS: Record<number, number> = { 2022: 763, 2023: 826, 2024: 829, 2025: 879, 2026: 7636 };

/** Резервні посилання data.gov.ua на випадок, якщо пошук не працює. */
const BUILTIN: Record<number, string> = {
  2006: 'a0c5d4c8-ae68-48b0-87c2-e4548b7774d4/resource/cb96289f-91d2-4735-8129-a08ee6336aa7',
  2007: 'dedce089-cf4b-4adf-97dc-1c5152080d05/resource/5a229344-3579-4348-94e8-36e1bbc1e13f',
  2008: '5d93b552-2049-43c2-b9a4-32e54653c7e6/resource/e37db396-34fd-40ff-a796-1faa4b5d41b1',
  2009: 'dc344166-85f7-4278-bae3-e33331c58029/resource/00a66d4c-77dd-4b83-b088-5ba95ec8ab4f',
  2010: '2fd047e6-35ff-4bf1-88f7-99b5261a9e7f/resource/09d32316-4b87-43d6-9229-db61deede73a',
  2011: '7e9ea7cc-fec1-45d7-8ebe-c0f3d3e406a6/resource/c302808b-6f86-4038-9e2b-340b6ef7b50f',
  2012: 'e3c22d72-6827-4ad6-888d-5da637f91dd1/resource/5854b509-88cb-41cd-9a7f-1d1309a48ff3',
  2013: '3bc24b95-1f9e-41d6-bffa-c57088474e4a/resource/19eadafb-552b-4eef-89d6-bd17bec95575',
  2014: 'e5c3c05a-61f5-4422-a41b-82dff1f71856/resource/93b30460-f857-4879-baf9-48bed096bea8',
  2015: '3951f2eb-a35b-4b35-a305-7afe471a9bca/resource/777859bd-f52c-478b-8d45-956facc40252',
  2016: '66169489-8877-48ae-a061-9eb91852876b/resource/b02dadfa-bea1-4a5e-b851-2a0888b87ef6',
  2017: 'a7a72086-8b58-478d-b84b-eaa27d06ae9f/resource/f227a599-08f3-471e-a621-afa3d292b7ed',
  2018: 'd2c2af31-cc4e-4a85-9f35-be4dba2354c2/resource/ed9575f6-8041-4581-8622-2fba792ee8ce',
  2019: '1c13f2f1-8bc4-41d4-81dc-ea4527fa73de/resource/c0985958-1fa9-435e-973b-a4863a8be027',
  2020: '83f1292d-43c9-43b8-8f89-aa2f3d14fd3a/resource/d89cd4cf-4705-4700-ba00-69a249ed9894',
  2021: 'bcffb3ae-8e4f-4443-8058-d525257ab69e/resource/d26fc705-6744-4c15-87cc-2ce472091101',
  2022: '42c195b3-b915-4000-934a-7741825d1812/resource/57e98c05-4426-41a0-86e7-e04cfe8f6a8c',
  2023: 'e0f2c66a-f773-442e-afcd-569be6a36c82/resource/eda19e26-6a9f-4ee7-bf9f-e8577a2f0814',
  2024: '1a6b5c08-0879-4387-8878-ac0027494274/resource/d3427d17-3fe4-4675-9a09-5274cd3476dc',
  2025: '2a95ae17-ed46-42ae-ad66-dd9b7a727bb7/resource/9f19ad2b-000f-4176-b283-95e399ad8e5e',
  2026: '16ab7f06-7414-405f-8354-0a492475272d/resource/b1a4ac1c-b17a-4988-8e6d-dedae8b2dd63',
};

function builtinUrl(year: number): string | undefined {
  const p = BUILTIN[year];
  return p ? `https://data.gov.ua/dataset/${p}/download/edrsr_data_${year}.zip` : undefined;
}

/** Архів старший за цей термін оновлюється примусово. */
export const MAX_ARCHIVE_AGE_DAYS = 7;

interface CatalogFile {
  updatedAt?: string;
  discovered: Record<string, DatasetSource[]>;
  probes: Record<string, { minId: number; source: string; probedAt: string }>;
  maxIdSeen: Record<string, number>;
  custom: CustomSourceEntry[];
  warnings: string[];
}

interface ZipMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  size: number;
  downloadedAt: string;
  /** Коли востаннє звіряли архів з сервером (без завантаження). */
  checkedAt?: string;
}

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;
type Progress = (done: number, total: number) => void;

const ORIGIN_ORDER: Record<string, number> = { file: 0, custom: 1, dsa: 2, 'data.gov.ua': 3, builtin: 4 };
const DAY = 24 * 3600_000;

export function currentYear(): number {
  return new Date().getFullYear();
}

export class Catalog {
  private lookupsCache?: Lookups;
  /** Завантаження, що вже виконуються: другий запит на той самий рік чекає на перше. */
  private inflight = new Map<number, { promise: Promise<string>; listeners: Set<Progress> }>();

  private constructor(
    private dir: DataDir,
    private platform: Platform,
    private state: CatalogFile,
    private log: Log,
  ) {}

  static async create(dir: DataDir, log: Log = () => undefined): Promise<Catalog> {
    const state = await dir.readJson<CatalogFile>('catalog.json', { discovered: {}, probes: {}, maxIdSeen: {}, custom: [], warnings: [] });
    state.discovered ??= {};
    state.probes ??= {};
    state.maxIdSeen ??= {};
    state.custom ??= [];
    state.warnings ??= [];
    return new Catalog(dir, dir.platform, state, log);
  }

  private save(): Promise<void> {
    return this.dir.writeJson('catalog.json', this.state);
  }

  private get fetchFn() {
    return this.platform.fetch;
  }

  // -------------------------------------------------------------------------
  // Пошук наборів

  /** Оновлює перелік річних наборів з data.gov.ua та сайту ДСА. */
  async refresh(signal?: AbortSignal): Promise<void> {
    const discovered: Record<string, DatasetSource[]> = {};
    const add = (year: number, src: DatasetSource) => {
      const list = (discovered[year] ??= []);
      if (!list.some((s) => s.url === src.url)) list.push(src);
    };
    const warnings: string[] = [];

    try {
      for (const s of await this.discoverDataGov(signal)) add(s.year, s.source);
    } catch (e) {
      if (isCancelled(e)) throw e;
      warnings.push(`Портал data.gov.ua недоступний: ${errorText(e)}`);
    }
    await Promise.all(
      Object.entries(DSA_PASSPORT_IDS).map(async ([year, id]) => {
        try {
          const r = await this.resolveDsaPassport(id, signal);
          if (r && r.year === Number(year)) add(r.year, { url: r.url, origin: 'dsa' });
        } catch (e) {
          if (isCancelled(e)) throw e;
          // сайт ДСА інколи недоступний — є інші джерела
        }
      }),
    );
    const cy = currentYear();
    if (!discovered[cy] && !this.state.custom.some((c) => c.year === cy)) {
      warnings.push(
        `Набір відкритих даних за ${cy} рік поки не знайдено. Зазвичай він з'являється на початку року; ` +
          'до того рішення поточного року не будуть знайдені. Якщо знаєте посилання — додайте його вручну.',
      );
    }
    this.state.discovered = discovered;
    this.state.updatedAt = new Date().toISOString();
    this.state.warnings = warnings;
    await this.save();
    const years = Object.keys(discovered);
    this.log(years.length ? 'info' : 'warn', years.length ? `Знайдено наборів відкритих даних: ${years.length} (роки ${years.sort().join(', ')})` : 'Не вдалося знайти набори даних онлайн — використовую вбудований список');
  }

  async refreshIfStale(maxAgeHours = 24, signal?: AbortSignal): Promise<void> {
    const at = this.state.updatedAt ? Date.parse(this.state.updatedAt) : 0;
    if (Date.now() - at > maxAgeHours * 3600_000 || !Object.keys(this.state.discovered).length) await this.refresh(signal);
  }

  private async discoverDataGov(signal?: AbortSignal): Promise<{ year: number; source: DatasetSource }[]> {
    const q = encodeURIComponent('"реєстр судових рішень"');
    const fq = encodeURIComponent(`organization:${DSA_ORG}`);
    type Pkg = { title: string; resources: { url: string; name?: string; size?: number; last_modified?: string; created?: string }[] };
    const json = await fetchJson<{ success: boolean; result: { results: Pkg[] } }>(this.fetchFn, `${CKAN}/package_search?q=${q}&fq=${fq}&rows=200`, signal);
    const out: { year: number; source: DatasetSource }[] = [];
    for (const pkg of json.result.results) {
      const m = /реєстр судових рішень за (\d{4})/i.exec(pkg.title);
      if (!m) continue;
      const year = Number(m[1]);
      const zips = pkg.resources
        .filter((r) => /\.zip($|\?)/i.test(r.url) && /edrsr_data/i.test(`${r.name} ${r.url}`))
        .sort((a, b) => (b.last_modified ?? b.created ?? '').localeCompare(a.last_modified ?? a.created ?? ''));
      if (zips[0]) out.push({ year, source: { url: zips[0].url, origin: 'data.gov.ua', size: zips[0].size } });
    }
    return out;
  }

  private async resolveDsaPassport(id: number | string, signal?: AbortSignal): Promise<{ year: number; url: string } | undefined> {
    const json = await fetchJson<{ Файли?: Record<string, string>[] }>(this.fetchFn, DSA_PASSPORT + id, signal);
    for (const f of json['Файли'] ?? []) {
      for (const [name, url] of Object.entries(f)) {
        const m = /edrsr_data_(\d{4})\.zip/i.exec(name);
        if (m) return { year: Number(m[1]), url };
      }
    }
    return undefined;
  }

  private async resolveDataGovDataset(id: string, signal?: AbortSignal): Promise<{ year: number; url: string } | undefined> {
    type Pkg = { title: string; resources: { url: string; name?: string }[] };
    const json = await fetchJson<{ result: Pkg }>(this.fetchFn, `${CKAN}/package_show?id=${encodeURIComponent(id)}`, signal);
    const m = /(\d{4})/.exec(json.result.title);
    const zip = json.result.resources.find((r) => /\.zip($|\?)/i.test(r.url));
    if (!m || !zip) return undefined;
    return { year: Number(m[1]), url: zip.url };
  }

  // -------------------------------------------------------------------------
  // Власні джерела

  /** Додає посилання: сторінку набору на сайті ДСА, набір на data.gov.ua або пряме посилання на ZIP. */
  async addCustomUrl(input: string, year?: number): Promise<CustomSourceEntry> {
    const text = input.trim();
    let resolved: { year: number; url: string } | undefined;
    const dsa = /oddata\/(\d+)/i.exec(text) ?? /open_data_json\.php\?json=(\d+)/i.exec(text);
    const dataGov = /data\.gov\.ua\/dataset\/([\w-]+)/i.exec(text);
    if (dsa) {
      resolved = await this.resolveDsaPassport(dsa[1]);
      if (!resolved) throw new Error('На сторінці набору ДСА не знайдено файлу edrsr_data_РРРР.zip');
    } else if (dataGov && !/\/download\//i.test(text)) {
      resolved = await this.resolveDataGovDataset(dataGov[1]);
      if (!resolved) throw new Error('У наборі data.gov.ua не знайдено ZIP-архіву');
    } else if (/^https?:\/\//i.test(text)) {
      const y = year ?? Number(/edrsr_data_(\d{4})/i.exec(text)?.[1]);
      if (!y) throw new Error('Не вдалося визначити рік з посилання — вкажіть рік вручну');
      resolved = { year: y, url: text };
    } else {
      throw new Error('Не вдалося розпізнати посилання. Підходить сторінка набору на dsa.court.gov.ua, набір на data.gov.ua або пряме посилання на ZIP.');
    }
    if (year && resolved.year !== year) resolved.year = year;
    const entry: CustomSourceEntry = { id: newId('src'), year: resolved.year, url: resolved.url, origin: 'custom', label: text };
    this.state.custom = this.state.custom.filter((c) => !(c.origin === 'custom' && c.url === entry.url));
    this.state.custom.push(entry);
    delete this.state.probes[entry.year];
    await this.save();
    return entry;
  }

  /** Додає архів, завантажений вручну (наприклад, браузером). */
  async addLocalFile(filePath: string, year?: number): Promise<CustomSourceEntry> {
    const entries = await this.platform.zipEntries(filePath);
    if (!entries.some((e) => e.toLowerCase().endsWith('documents.csv'))) throw new Error('Це не архів відкритих даних ЄДРСР: всередині немає documents.csv');
    const y = year ?? Number(/edrsr_data_(\d{4})/i.exec(filePath)?.[1]);
    if (!y) throw new Error('Не вдалося визначити рік з назви файлу — вкажіть рік вручну');
    const entry: CustomSourceEntry = { id: newId('src'), year: y, url: filePath, origin: 'file', label: filePath };
    this.state.custom = this.state.custom.filter((c) => !(c.origin === 'file' && c.year === y));
    this.state.custom.push(entry);
    delete this.state.probes[y];
    this.lookupsCache = undefined;
    await this.save();
    return entry;
  }

  async removeCustom(id: string): Promise<void> {
    const entry = this.state.custom.find((c) => c.id === id);
    this.state.custom = this.state.custom.filter((c) => c.id !== id);
    if (entry) delete this.state.probes[entry.year];
    await this.save();
  }

  // -------------------------------------------------------------------------
  // Роки, джерела, кеш

  years(): number[] {
    const set = new Set<number>([...Object.keys(this.state.discovered).map(Number), ...this.state.custom.map((c) => c.year)]);
    if (!Object.keys(this.state.discovered).length) Object.keys(BUILTIN).forEach((y) => set.add(Number(y)));
    return [...set].sort((a, b) => b - a);
  }

  sources(year: number): DatasetSource[] {
    const list: DatasetSource[] = [];
    const push = (s: DatasetSource) => !list.some((x) => x.url === s.url) && list.push(s);
    this.state.custom.filter((c) => c.year === year).forEach((c) => push({ url: c.url, origin: c.origin }));
    (this.state.discovered[year] ?? []).forEach(push);
    const b = builtinUrl(year);
    if (b) push({ url: b, origin: 'builtin' });
    return list.sort((a, b2) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b2.origin]);
  }

  private zipPath(year: number): string {
    return this.dir.path('registry', `edrsr_data_${year}.zip`);
  }

  private metaRel(year: number): string {
    return `registry/edrsr_data_${year}.json`;
  }

  private async localFile(year: number): Promise<string | undefined> {
    const f = this.state.custom.find((c) => c.year === year && c.origin === 'file');
    return f && (await this.platform.stat(f.url)) ? f.url : undefined;
  }

  /** Шлях до наявного архіву року (вибраного вручну або завантаженого). */
  async archivePath(year: number): Promise<string | undefined> {
    const local = await this.localFile(year);
    if (local) return local;
    const p = this.zipPath(year);
    return (await this.platform.stat(p)) ? p : undefined;
  }

  private zipMeta(year: number): Promise<ZipMeta | undefined> {
    return this.dir.readJson<ZipMeta | undefined>(this.metaRel(year), undefined);
  }

  /** Архів поточного року оновлюється щодня — після 12 годин вважаємо його застарілим. */
  async isStale(year: number): Promise<boolean> {
    if (await this.localFile(year)) return false;
    const meta = await this.zipMeta(year);
    if (!meta) return true;
    const cy = currentYear();
    const live = year === cy || (year === cy - 1 && new Date().getMonth() < 2);
    return live && Date.now() - Date.parse(meta.downloadedAt) > 12 * 3600_000;
  }

  /** Чи завантажений архів не звіряли з сервером довше за тиждень. */
  async isOutdated(year: number): Promise<boolean> {
    if (await this.localFile(year)) return false;
    const meta = await this.zipMeta(year);
    if (!meta || !(await this.platform.stat(this.zipPath(year)))) return false;
    return Date.now() - Date.parse(meta.checkedAt ?? meta.downloadedAt) > MAX_ARCHIVE_AGE_DAYS * DAY;
  }

  /** Роки, архіви яких завантажено і які потребують щотижневого оновлення. */
  async outdatedYears(): Promise<number[]> {
    const out: number[] = [];
    for (const y of this.years()) if (await this.isOutdated(y)) out.push(y);
    return out;
  }

  /**
   * Примусове щотижневе оновлення: звіряє архів з сервером (HEAD) і завантажує
   * заново, лише якщо файл на сервері змінився. Помилка мережі не зупиняє роботу —
   * використовується наявний архів.
   */
  async ensureFresh(year: number, opts: { signal?: AbortSignal; onProgress?: Progress; force?: boolean } = {}): Promise<'fresh' | 'unchanged' | 'updated' | 'failed'> {
    if (await this.localFile(year)) return 'fresh';
    const meta = await this.zipMeta(year);
    if (!meta || !(opts.force || (await this.isOutdated(year)))) return 'fresh';
    const remote = this.sources(year).find((s) => s.origin !== 'file');
    if (!remote) return 'fresh';
    try {
      if (remote.url === meta.url) {
        const res = await fetchWithRetry(this.fetchFn, remote.url, { method: 'HEAD' }, { signal: opts.signal, retries: 1 });
        const etag = res.headers.get('etag') ?? undefined;
        const size = Number(res.headers.get('content-length'));
        const sameEtag = etag !== undefined && meta.etag !== undefined && etag === meta.etag;
        const sameSize = Number.isFinite(size) && size === meta.size;
        if (sameEtag || (!etag && !meta.etag && sameSize)) {
          await this.dir.writeJson(this.metaRel(year), { ...meta, checkedAt: new Date().toISOString() } satisfies ZipMeta);
          this.log('info', `Архів за ${year} рік не змінився з ${new Date(meta.downloadedAt).toLocaleDateString('uk-UA')}`);
          return 'unchanged';
        }
      }
      this.log('info', `На сервері нова версія архіву за ${year} рік — оновлюю`);
      await this.download(year, opts);
      return 'updated';
    } catch (e) {
      if (isCancelled(e)) throw e;
      this.log('warn', `Не вдалося оновити архів за ${year} рік (${errorText(e)}) — використовую збережений`);
      return 'failed';
    }
  }

  async deleteCache(year: number): Promise<void> {
    for (const f of [`edrsr_data_${year}.zip`, `edrsr_data_${year}.zip.part`, `edrsr_data_${year}.zip.part.json`, `edrsr_data_${year}.json`, `lookups_${year}.json`]) {
      await this.dir.remove(`registry/${f}`);
    }
    delete this.state.maxIdSeen[year];
    this.lookupsCache = undefined;
    await this.save();
  }

  minIdOf(year: number): number | undefined {
    return this.state.probes[year]?.minId;
  }

  async setMaxIdSeen(year: number, maxId: number): Promise<void> {
    this.state.maxIdSeen[year] = maxId;
    await this.save();
  }

  /** Чи виконується зараз завантаження архіву цього року. */
  downloading(year: number): boolean {
    return this.inflight.has(year);
  }

  /** Завантажує архів року (з докачуванням). Повторний виклик під час завантаження чекає на нього. */
  download(year: number, opts: { signal?: AbortSignal; onProgress?: Progress } = {}): Promise<string> {
    const running = this.inflight.get(year);
    if (running) {
      if (opts.onProgress) running.listeners.add(opts.onProgress);
      return running.promise;
    }
    const listeners = new Set<Progress>(opts.onProgress ? [opts.onProgress] : []);
    const promise = this.doDownload(year, opts.signal, (d, t) => listeners.forEach((l) => l(d, t))).finally(() => this.inflight.delete(year));
    this.inflight.set(year, { promise, listeners });
    return promise;
  }

  private async doDownload(year: number, signal: AbortSignal | undefined, onProgress: Progress): Promise<string> {
    const local = await this.localFile(year);
    if (local) return local;
    const sources = this.sources(year).filter((s) => s.origin !== 'file');
    if (!sources.length) throw new Error(`Немає джерела даних за ${year} рік. Додайте посилання на розділі «Дані реєстру».`);
    const dest = this.zipPath(year);
    const part = `${dest}.part`;
    const partMetaRel = `registry/edrsr_data_${year}.zip.part.json`;
    let lastError: unknown;

    for (const src of sources) {
      try {
        const partMeta = await this.dir.readJson<{ url: string; etag?: string } | undefined>(partMetaRel, undefined);
        const partStat = await this.platform.stat(part);
        const resumeFrom = partStat && partMeta?.url === src.url && partMeta.etag ? partStat.size : 0;
        this.log('info', `Завантаження архіву за ${year} рік (${src.origin})${resumeFrom ? `, продовження з ${(resumeFrom / 1e6).toFixed(0)} МБ` : ''}…`);
        // Метадані частково завантаженого файлу (для докачування) записуємо до початку.
        const head = await fetchWithRetry(this.fetchFn, src.url, { method: 'HEAD' }, { signal, retries: 1 }).catch(() => undefined);
        await this.dir.writeJson(partMetaRel, { url: src.url, etag: head?.headers.get('etag') ?? undefined });
        const res = await this.platform.download(src.url, part, { resumeFrom, ifRange: partMeta?.etag, signal, onProgress });
        if (res.total && res.size !== res.total) throw new Error(`завантажено ${res.size} з ${res.total} байтів`);
        const entries = await this.platform.zipEntries(part);
        if (!entries.some((e) => e.toLowerCase().endsWith('documents.csv'))) throw new Error('завантажений файл не містить documents.csv');

        await this.platform.rename(part, dest);
        await this.dir.remove(partMetaRel);
        await this.dir.remove(`registry/lookups_${year}.json`);
        this.lookupsCache = undefined;
        const now = new Date().toISOString();
        await this.dir.writeJson(this.metaRel(year), {
          url: src.url,
          etag: res.etag ?? undefined,
          lastModified: res.lastModified ?? undefined,
          size: res.size,
          downloadedAt: now,
          checkedAt: now,
        } satisfies ZipMeta);
        this.log('info', `Архів за ${year} рік завантажено (${(res.size / 1e6).toFixed(0)} МБ)`);
        return dest;
      } catch (e) {
        if (isCancelled(e)) throw new CancelledError();
        lastError = e;
        this.log('warn', `Джерело ${src.origin} за ${year} рік не спрацювало: ${errorText(e)}`);
      }
    }
    throw new Error(`Не вдалося завантажити архів за ${year} рік: ${errorText(lastError)}`);
  }

  // -------------------------------------------------------------------------
  // Діапазони ID

  /** Визначає мінімальний doc_id року, читаючи лише початок архіву. */
  async probe(year: number): Promise<number | undefined> {
    const cached = this.state.probes[year];
    if (cached) return cached.minId;
    const archive = await this.archivePath(year);
    const candidates = [...(archive ? [archive] : []), ...this.sources(year).filter((x) => x.origin !== 'file').map((s) => s.url)];
    for (const source of candidates) {
      try {
        const minId = minIdFromHead(await this.platform.zipProbe(source));
        if (minId) {
          this.state.probes[year] = { minId, source, probedAt: new Date().toISOString() };
          await this.save();
          return minId;
        }
      } catch (e) {
        this.log('warn', `Не вдалося визначити діапазон ID за ${year} рік: ${errorText(e)}`);
      }
    }
    return undefined;
  }

  /**
   * Розподіляє ID рішень за роками архівів. ID у реєстрі зростають з часом,
   * тому рік визначається за мінімальним ID кожного річного набору.
   */
  async route(ids: string[], signal?: AbortSignal): Promise<{ byYear: Map<number, string[]>; unknown: string[] }> {
    const nums = ids.map(Number);
    const smallest = Math.min(...nums);
    const bounds: { year: number; minId: number }[] = [];
    for (const year of this.years()) {
      if (signal?.aborted) throw new CancelledError();
      const minId = await this.probe(year);
      if (minId !== undefined) bounds.push({ year, minId });
      if (minId !== undefined && minId <= smallest) break;
    }
    bounds.sort((a, b) => a.minId - b.minId);
    const byYear = new Map<number, string[]>();
    const unknown: string[] = [];
    ids.forEach((id, i) => {
      let target: number | undefined;
      for (const b of bounds) if (b.minId <= nums[i]) target = b.year;
      if (target === undefined) unknown.push(id);
      else byYear.set(target, [...(byYear.get(target) ?? []), id]);
    });
    return { byYear, unknown };
  }

  // -------------------------------------------------------------------------
  // Довідники

  async lookups(): Promise<Lookups> {
    if (this.lookupsCache) return this.lookupsCache;
    const list: Lookups[] = [];
    for (const year of [...this.years()].reverse()) {
      const archive = await this.archivePath(year);
      if (!archive) continue;
      const rel = `registry/lookups_${year}.json`;
      let l = await this.dir.readJson<Lookups | undefined>(rel, undefined);
      if (!l) {
        try {
          l = lookupsFromTables(await this.platform.zipTables(archive, LOOKUP_TABLES));
          if (!(await this.localFile(year))) await this.dir.writeJson(rel, l);
        } catch (e) {
          this.log('warn', `Не вдалося прочитати довідники за ${year} рік: ${errorText(e)}`);
          continue;
        }
      }
      list.push(l);
    }
    this.lookupsCache = mergeLookups(list);
    return this.lookupsCache;
  }

  // -------------------------------------------------------------------------

  async view(): Promise<CatalogView> {
    const years: YearView[] = [];
    for (const year of this.years()) {
      const local = await this.localFile(year);
      const p = local ?? this.zipPath(year);
      const st = await this.platform.stat(p);
      const meta = local ? undefined : await this.zipMeta(year);
      years.push({
        year,
        sources: this.sources(year),
        minId: this.state.probes[year]?.minId,
        maxIdSeen: this.state.maxIdSeen[year],
        cache: st ? { size: st.size, downloadedAt: meta?.downloadedAt ?? new Date(st.mtimeMs).toISOString(), checkedAt: meta?.checkedAt, local: Boolean(local), path: p } : undefined,
      });
    }
    return {
      years,
      updatedAt: this.state.updatedAt,
      warnings: this.state.warnings,
      custom: this.state.custom,
      dataDir: this.dir.root,
      textCache: await this.platform.dirStats(this.dir.path('texts')),
    };
  }
}
