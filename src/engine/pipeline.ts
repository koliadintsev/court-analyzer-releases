// Конвеєр: пошук рішень у відкритих даних → формальні фільтри → тексти → ШІ-фільтр → ШІ-витяг.
import { JUDGMENT_FORMS, JUSTICE_KINDS, INSTANCES } from '../shared/registry';
import type { AppSettings, DecisionRecord, ProviderId, RecordStatus, RunEvent, RunInfo, RunRequest, SavedRun, StageModel } from '../shared/types';
import { AiFatalError, createClient, type AiClient, type CompletionRequest } from './ai';
import { currentYear, type Catalog } from './catalog';
import { formatDate, instanceCode, metaValue, parseRegistryDate } from './format';
import { CancelledError, errorText, isCancelled, throwIfAborted } from './http';
import {
  buildExtractionPrompt,
  buildFilterPrompt,
  decisionMessage,
  enabledAiFields,
  extractionSchema,
  filterSchema,
  normalizeExtraction,
  splitText,
  truncateMiddle,
  type DecisionInfo,
} from './prompts';
import { scanArchive } from './registry';
import type { DataDir } from './storage';
import type { TextStore } from './texts';

export interface PipelineDeps {
  dir: DataDir;
  catalog: Catalog;
  texts: TextStore;
  settings: AppSettings;
  getKey: (p: ProviderId) => string | undefined;
  emit: (e: RunEvent) => void;
  signal: AbortSignal;
}

/** Виконує fn для елементів з обмеженням паралельності. */
export async function mapLimit<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < items.length && failure === undefined) {
      throwIfAborted(signal);
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure !== undefined) throw failure;
}

function runIdNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const PROVIDER_TITLES: Record<ProviderId, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', compatible: 'OpenAI-сумісного провайдера' };

export async function runPipeline(req: RunRequest, deps: PipelineDeps): Promise<SavedRun> {
  const { catalog, texts, settings, emit, signal, dir } = deps;
  const platform = dir.platform;
  const profile = req.profile;
  const f = profile.filters;
  const log = (level: 'info' | 'warn' | 'error', message: string) => emit({ type: 'log', level, message, time: new Date().toISOString() });
  const records = new Map<string, DecisionRecord>(req.ids.map((id) => [id, { docId: id, status: 'pending' }]));
  const update = (rec: DecisionRecord, patch: Partial<DecisionRecord>) => {
    Object.assign(rec, patch);
    emit({ type: 'record', record: { ...rec } });
  };
  const pending = () => [...records.values()].filter((r) => r.status === 'pending');

  const aiFields = enabledAiFields(profile);
  const useFilter = f.aiFilterEnabled && f.aiCriterion.trim().length > 0;
  const useExtract = profile.extraction.enabled && aiFields.length > 0;
  const run: SavedRun = {
    id: runIdNow(),
    startedAt: new Date().toISOString(),
    profile,
    models: { filter: useFilter ? settings.ai.filter : undefined, extract: useExtract ? settings.ai.extract : undefined },
    records: [],
  };
  const save = async () => {
    run.records = [...records.values()];
    await dir.writeJson(`runs/${run.id}.json`, run);
  };

  // Клієнти ШІ створюємо до початку довгих етапів, щоб одразу повідомити про відсутній ключ.
  const makeClient = (stage: StageModel): AiClient => {
    const key = deps.getKey(stage.provider) ?? '';
    if (!key && stage.provider !== 'compatible') throw new Error(`Не задано API-ключ для ${PROVIDER_TITLES[stage.provider]}. Відкрийте «Налаштування ШІ».`);
    if (!stage.model.trim()) throw new Error('Не обрано модель ШІ. Відкрийте «Налаштування ШІ».');
    return createClient(stage.provider, stage.model.trim(), {
      apiKey: key,
      baseUrl: stage.provider === 'compatible' ? settings.ai.compatibleBaseUrl : undefined,
      fetchFn: platform.fetch,
      onRetry: (attempt, reason, delay) => log('warn', `ШІ: повтор запиту №${attempt} через ${Math.round(delay / 1000)} с (${reason})`),
    });
  };
  const filterClient = useFilter ? makeClient(settings.ai.filter) : undefined;
  const extractClient = useExtract ? makeClient(settings.ai.extract) : undefined;

  let cancelled = false;
  try {
    // ---------------------------------------------------------------- 1. Реєстр
    emit({ type: 'stage', stage: 'registry', label: 'Пошук рішень у відкритих даних реєстру' });
    log('info', `Рішень у переліку: ${records.size}`);
    await catalog.refreshIfStale(24, signal);
    const { byYear, unknown } = await catalog.route(req.ids, signal);
    for (const id of unknown) update(records.get(id)!, { status: 'not_found', reason: 'Не вдалося визначити рік набору відкритих даних для цього ID (перевірте номер або додайте набір у «Дані реєстру»)' });

    log('info', `Потрібні архіви за роки: ${[...byYear.keys()].sort((a, b) => b - a).join(', ') || '—'}`);
    // Черга «рік → ID». ID біля межі року, не знайдені у своєму архіві, перевіряються в сусідньому.
    const queue = new Map<number, Set<string>>();
    const tried = new Map<string, Set<number>>();
    const enqueue = (year: number, id: string) => {
      if (!tried.has(id)) tried.set(id, new Set());
      tried.get(id)!.add(year);
      if (!queue.has(year)) queue.set(year, new Set());
      queue.get(year)!.add(id);
    };
    for (const [year, list] of byYear) list.forEach((id) => enqueue(year, id));
    const available = new Set(catalog.years());
    const BOUNDARY = 20_000;
    const neighbour = (id: string, year: number): number | undefined => {
      const n = Number(id);
      const nextMin = catalog.minIdOf(year + 1);
      const ownMin = catalog.minIdOf(year);
      if (available.has(year + 1) && !tried.get(id)!.has(year + 1) && nextMin !== undefined && nextMin - n <= BOUNDARY) return year + 1;
      if (available.has(year - 1) && !tried.get(id)!.has(year - 1) && ownMin !== undefined && n - ownMin <= BOUNDARY) return year - 1;
      return undefined;
    };

    while (queue.size) {
      const year = Math.max(...queue.keys());
      const ids = [...queue.get(year)!];
      queue.delete(year);
      const progress = (detail: string) => (done: number, total: number) => emit({ type: 'progress', stage: 'registry', done, total, detail, unit: 'bytes' });
      let archive = await catalog.archivePath(year);
      let fresh = false;
      if (!archive) {
        archive = await catalog.download(year, { signal, onProgress: progress(`Завантаження архіву за ${year} рік`) });
        fresh = true;
      } else {
        // Архіви старші за тиждень оновлюються примусово.
        const r = await catalog.ensureFresh(year, { signal, onProgress: progress(`Оновлення архіву за ${year} рік`) });
        fresh = r === 'updated' || r === 'unchanged';
      }
      const scan = async (wanted: string[]) => {
        log('info', `Пошук ${wanted.length} рішень в архіві за ${year} рік…`);
        const res = await scanArchive(platform, archive!, wanted, {
          signal,
          onProgress: (fr) => emit({ type: 'progress', stage: 'registry', done: Math.round(fr * 1000), total: 1000, detail: `Пошук в архіві за ${year} рік`, unit: 'fraction' }),
        });
        if (res.complete) await catalog.setMaxIdSeen(year, res.maxId);
        for (const [id, row] of res.found) update(records.get(id)!, { meta: row, year });
        return wanted.filter((id) => !res.found.has(id));
      };
      let missing = await scan(ids);
      if (missing.length && !fresh && (await catalog.isStale(year))) {
        log('info', `${missing.length} рішень не знайдено в збереженому архіві за ${year} рік — перевіряю, чи є новіша версія`);
        const r = await catalog.ensureFresh(year, { signal, force: true, onProgress: progress(`Оновлення архіву за ${year} рік`) });
        if (r === 'updated') missing = await scan(missing);
      }
      const recent = year >= currentYear() - 1;
      for (const id of missing) {
        const next = neighbour(id, year);
        if (next !== undefined) {
          enqueue(next, id);
          continue;
        }
        update(records.get(id)!, {
          status: 'not_found',
          year,
          reason: `Не знайдено в архіві відкритих даних за ${year} рік${recent ? ' (можливо, рішення ще не потрапило до відкритих даних — вони оновлюються раз на добу)' : ''}`,
        });
      }
    }
    await save();

    // ---------------------------------------------------------------- 2. Формальні фільтри
    const lookups = await catalog.lookups();
    const formName = (c: string) => lookups.judgmentForms[c] ?? JUDGMENT_FORMS[c] ?? c;
    const info = (rec: DecisionRecord): DecisionInfo => ({
      court: String(metaValue('court', rec, lookups) ?? ''),
      instance: String(metaValue('instance', rec, lookups) ?? ''),
      justiceKind: String(metaValue('justice_kind', rec, lookups) ?? ''),
      form: String(metaValue('judgment_form', rec, lookups) ?? ''),
      date: formatDate(parseRegistryDate(rec.meta?.adjudication_date)),
      causeNum: rec.meta?.cause_num,
    });
    for (const rec of pending()) {
      const m = rec.meta;
      if (!m) {
        update(rec, { status: 'not_found', reason: 'Немає даних у реєстрі' });
        continue;
      }
      const date = m.adjudication_date.slice(0, 10);
      const inst = instanceCode(rec, lookups);
      if (f.judgmentForms.length && !f.judgmentForms.includes(m.judgment_code)) update(rec, { status: 'filtered_meta', reason: `Форма рішення: ${formName(m.judgment_code)}` });
      else if (f.justiceKinds.length && !f.justiceKinds.includes(m.justice_kind)) update(rec, { status: 'filtered_meta', reason: `Вид судочинства: ${JUSTICE_KINDS[m.justice_kind] ?? m.justice_kind}` });
      else if (f.instances.length && !(inst && f.instances.includes(inst))) update(rec, { status: 'filtered_meta', reason: `Інстанція: ${inst ? INSTANCES[inst] ?? inst : 'невідомо'}` });
      else if (f.dateFrom && date && date < f.dateFrom) update(rec, { status: 'filtered_meta', reason: `Дата рішення ${date} раніше ${f.dateFrom}` });
      else if (f.dateTo && date && date > f.dateTo) update(rec, { status: 'filtered_meta', reason: `Дата рішення ${date} пізніше ${f.dateTo}` });
      else if (!m.doc_url) update(rec, { status: 'no_text', reason: 'Текст рішення не оприлюднено у відкритих даних' });
    }

    // ---------------------------------------------------------------- 3. Тексти
    const forTexts = pending();
    emit({ type: 'stage', stage: 'texts', label: 'Завантаження текстів рішень' });
    let textsDone = 0;
    emit({ type: 'progress', stage: 'texts', done: 0, total: forTexts.length });
    await mapLimit(forTexts, settings.textConcurrency, signal, async (rec) => {
      try {
        const text = await texts.get(rec.meta!, signal);
        if (!text.trim()) update(rec, { status: 'no_text', reason: 'Порожній текст рішення', textLength: 0 });
        else if (text.length < f.minTextLength) update(rec, { status: 'too_short', reason: `Текст коротший за ${f.minTextLength} символів (${text.length})`, textLength: text.length });
        else update(rec, { textLength: text.length });
      } catch (e) {
        if (isCancelled(e)) throw e;
        update(rec, { status: 'error', reason: `Не вдалося завантажити текст: ${errorText(e)}` });
      }
      emit({ type: 'progress', stage: 'texts', done: ++textsDone, total: forTexts.length });
    });
    log('info', `Тексти отримано: ${forTexts.filter((r) => r.status === 'pending').length} з ${forTexts.length}`);
    await save();

    // ---------------------------------------------------------------- 4. ШІ-фільтр
    const aiCache = new AiCache(dir);
    if (filterClient) {
      const list = pending();
      emit({ type: 'stage', stage: 'filter', label: `ШІ-фільтр за темою (${settings.ai.filter.model})` });
      let done = 0;
      emit({ type: 'progress', stage: 'filter', done: 0, total: list.length });
      const schema = filterSchema();
      await mapLimit(list, settings.ai.concurrency, signal, async (rec) => {
        const text = (await texts.cached(rec.docId)) ?? '';
        try {
          const chunks = splitText(text, settings.ai.maxInputChars);
          let verdict = { relevant: false, reason: '' };
          for (let i = 0; i < chunks.length; i++) {
            const part = chunks.length > 1 ? { index: i + 1, total: chunks.length } : undefined;
            const system = buildFilterPrompt(profile, part);
            const user = decisionMessage(chunks[i], info(rec), part);
            const raw = await aiCache.complete(filterClient, settings.ai.filter, { system, user, schema, schemaName: 'relevance', signal }, rec.docId);
            verdict = { relevant: raw.relevant === true || raw.relevant === 'true', reason: String(raw.reason ?? '') };
            if (verdict.relevant) break;
          }
          update(rec, { relevance: verdict, status: verdict.relevant ? 'relevant' : 'irrelevant', reason: verdict.reason });
        } catch (e) {
          if (isCancelled(e) || e instanceof AiFatalError) throw e;
          update(rec, { status: 'error', reason: `ШІ-фільтр: ${errorText(e)}` });
        }
        emit({ type: 'progress', stage: 'filter', done: ++done, total: list.length });
      });
      const rel = list.filter((r) => r.status === 'relevant').length;
      log('info', `ШІ-фільтр: релевантних ${rel} з ${list.length}`);
      await save();
    }
    for (const rec of pending()) update(rec, { status: 'relevant' });

    // ---------------------------------------------------------------- 5. ШІ-витяг
    const relevant = [...records.values()].filter((r) => r.status === 'relevant');
    if (extractClient) {
      emit({ type: 'stage', stage: 'extract', label: `Витяг даних (${settings.ai.extract.model})` });
      let done = 0;
      emit({ type: 'progress', stage: 'extract', done: 0, total: relevant.length });
      const unknown = profile.extraction.unknownValue || 'невідомо';
      const schema = extractionSchema(aiFields, unknown);
      const system = buildExtractionPrompt(profile, aiFields);
      await mapLimit(relevant, settings.ai.concurrency, signal, async (rec) => {
        const text = truncateMiddle((await texts.cached(rec.docId)) ?? '', settings.ai.maxInputChars);
        try {
          const user = decisionMessage(text, info(rec));
          const raw = await aiCache.complete(extractClient, settings.ai.extract, { system, user, schema, schemaName: 'decision_data', signal }, rec.docId);
          update(rec, { data: normalizeExtraction(raw, aiFields, unknown), status: 'done' });
        } catch (e) {
          if (isCancelled(e) || e instanceof AiFatalError) throw e;
          update(rec, { status: 'error', reason: `Витяг даних: ${errorText(e)}` });
        }
        emit({ type: 'progress', stage: 'extract', done: ++done, total: relevant.length });
      });
    } else {
      for (const rec of relevant) update(rec, { status: 'done' });
    }
  } catch (e) {
    if (isCancelled(e)) {
      cancelled = true;
      log('warn', 'Обробку зупинено. Повторний запуск продовжить з місця зупинки — тексти й відповіді ШІ збережено в кеші.');
    } else {
      run.error = errorText(e);
      log('error', run.error);
    }
  }

  const counts: Partial<Record<RecordStatus, number>> = {};
  for (const r of records.values()) counts[r.status] = (counts[r.status] ?? 0) + 1;
  run.finishedAt = new Date().toISOString();
  run.summary = { total: records.size, counts, startedAt: run.startedAt, finishedAt: run.finishedAt, cancelled };
  await save();
  if (run.error) emit({ type: 'failed', message: run.error });
  emit({ type: 'finished', summary: run.summary, runId: run.id });
  return run;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Кеш відповідей ШІ: повторний запуск з тими самими параметрами не витрачає кошти. */
class AiCache {
  constructor(private dir: DataDir) {}

  async complete(client: AiClient, model: StageModel, req: CompletionRequest, docId: string): Promise<Record<string, unknown>> {
    const key = (await sha256(JSON.stringify([model.provider, model.model, req.system, req.schema, req.user.length, docId]))).slice(0, 40);
    const rel = `ai-cache/${key}.json`;
    const hit = await this.dir.readJson<Record<string, unknown> | undefined>(rel, undefined);
    if (hit) return hit;
    if (req.signal?.aborted) throw new CancelledError();
    const result = await client.complete(req);
    await this.dir.writeJson(rel, result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Історія запусків

export function loadRun(dir: DataDir, id: string): Promise<SavedRun | undefined> {
  return dir.readJson<SavedRun | undefined>(`runs/${id}.json`, undefined);
}

export async function deleteRun(dir: DataDir, id: string): Promise<void> {
  if (/^[\w-]+$/.test(id)) await dir.remove(`runs/${id}.json`);
}

export async function listRuns(dir: DataDir, limit = 200): Promise<RunInfo[]> {
  const names = (await dir.platform.listDir(dir.path('runs')))
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  const out: RunInfo[] = [];
  for (const n of names) {
    const r = await loadRun(dir, n.replace(/\.json$/, ''));
    if (!r) continue;
    const counts: RunInfo['counts'] = r.summary?.counts ?? {};
    if (!r.summary) for (const x of r.records) counts[x.status] = (counts[x.status] ?? 0) + 1;
    out.push({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      profileName: r.profile.name,
      total: r.records.length,
      done: counts.done ?? 0,
      counts,
      cancelled: Boolean(r.summary?.cancelled),
      error: r.error,
    });
  }
  return out;
}
