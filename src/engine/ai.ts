// Клієнти ШІ-провайдерів зі структурованими (JSON) відповідями. Без SDK — прямі HTTP-запити.
import type { ModelInfo, ProviderId } from '../shared/types';
import { HttpError, fetchWithRetry, type FetchFn } from './http';

const LIGHT = /(mini|nano|flash|lite|haiku|small|fast|\b\d{1,2}b\b)/i;

function modelInfo(id: string, name?: string): ModelInfo {
  return { id, name: name || id, light: LIGHT.test(id) };
}

/** Моделі OpenAI, придатні для аналізу тексту (без аудіо, зображень, знімків з датою тощо). */
export function relevantOpenAiModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-)/i.test(id)) return false;
  if (/(audio|realtime|transcribe|tts|image|search|embed|moderation|instruct|codex|computer-use|oss|dall-e|sora)/i.test(id)) return false;
  return !/-\d{4}-\d{2}-\d{2}$/.test(id) && !/-\d{4}$/.test(id);
}

/** Моделі Gemini для генерації тексту (без embedding, зображень, аудіо, live). */
export function relevantGeminiModel(id: string): boolean {
  return /gemini/i.test(id) && !/(embedding|imagen|image|tts|audio|live|aqa|robotics|computer-use|native|exp-\d{4})/i.test(id);
}

/** Сортування: аліаси *-latest першими, далі новіші версії. */
function byRecency(a: ModelInfo, b: ModelInfo): number {
  const latest = Number(/latest/.test(b.id)) - Number(/latest/.test(a.id));
  return latest || b.id.localeCompare(a.id, 'en', { numeric: true });
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

export interface CompletionRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  schemaName: string;
  signal?: AbortSignal;
}

export interface AiClient {
  readonly label: string;
  complete(req: CompletionRequest): Promise<Record<string, unknown>>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn: FetchFn;
  onRetry?: (attempt: number, reason: string, delayMs: number) => void;
}

/** Помилка, через яку немає сенсу продовжувати (невірний ключ, модель не існує). */
export class AiFatalError extends Error {}

function providerMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    return String(e?.message ?? j.message ?? body).slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function describeHttpError(e: HttpError, label: string, model: string): Error {
  const msg = providerMessage(e.body);
  if (e.status === 401 || e.status === 403) return new AiFatalError(`${label}: API-ключ невірний або не має доступу (HTTP ${e.status}). ${msg}`);
  if (e.status === 404) return new AiFatalError(`${label}: модель «${model}» не знайдено або вона недоступна для цього ключа. ${msg}`);
  if (e.status === 429) return new Error(`${label}: перевищено ліміт запитів або вичерпано баланс (HTTP 429). ${msg}`);
  if (e.status === 400 && /model/i.test(msg) && /(not found|invalid|does not exist|unknown|not supported)/i.test(msg)) {
    return new AiFatalError(`${label}: модель «${model}» не підтримується. ${msg}`);
  }
  return new Error(`${label}: помилка HTTP ${e.status}. ${msg}`);
}

/** Розбирає JSON з відповіді моделі, навіть якщо його обгорнуто в ```json … ```. */
export function parseJsonLoose(text: string): Record<string, unknown> {
  const t = text.trim();
  const attempts = [t, /```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)];
  for (const a of attempts) {
    if (!a) continue;
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // наступна спроба
    }
  }
  throw new Error(`ШІ повернув відповідь не у форматі JSON: ${t.slice(0, 200)}`);
}

async function postJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, body: unknown, opts: ClientOptions, signal?: AbortSignal): Promise<any> {
  const res = await fetchWithRetry(
    fetchFn,
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    { signal, retries: 5, baseDelayMs: 2000, onRetry: opts.onRetry },
  );
  return res.json();
}

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await fetchWithRetry(fetchFn, url, { headers }, { signal, retries: 1 });
  return res.json();
}

const SCHEMA_HINT = (schema: JsonSchema) =>
  `\n\nВідповідь надай виключно у форматі JSON, що відповідає цій JSON Schema:\n${JSON.stringify(schema, null, 2)}`;

// ---------------------------------------------------------------------------

function openAiClient(provider: 'openai' | 'compatible', model: string, opts: ClientOptions): AiClient {
  const label = provider === 'openai' ? 'OpenAI' : 'OpenAI-сумісний провайдер';
  const base = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers: Record<string, string> = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};
  // Не всі сумісні сервери підтримують json_schema — тоді знижуємо вимоги.
  let mode: 'schema' | 'object' | 'plain' = 'schema';

  return {
    label,
    async complete(req) {
      for (;;) {
        const system = mode === 'schema' ? req.system : req.system + SCHEMA_HINT(req.schema);
        const body: Record<string, unknown> = {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: req.user },
          ],
        };
        if (mode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } };
        if (mode === 'object') body.response_format = { type: 'json_object' };
        try {
          const json = await postJson(opts.fetchFn, `${base}/chat/completions`, headers, body, opts, req.signal);
          const msg = json.choices?.[0]?.message;
          if (msg?.refusal) throw new Error(`${label}: модель відмовилась відповідати: ${msg.refusal}`);
          const content = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: { text?: string }) => p.text ?? '').join('') : '';
          if (!content) throw new Error(`${label}: порожня відповідь моделі (finish_reason: ${json.choices?.[0]?.finish_reason ?? '—'})`);
          return parseJsonLoose(content);
        } catch (e) {
          if (e instanceof HttpError && e.status === 400 && mode !== 'plain' && /response_format|json_schema|json_object|schema/i.test(e.body)) {
            mode = mode === 'schema' ? 'object' : 'plain';
            continue;
          }
          throw e instanceof HttpError ? describeHttpError(e, label, model) : e;
        }
      }
    },
    async listModels(signal) {
      try {
        const json = await getJson(opts.fetchFn, `${base}/models`, headers, signal);
        const list: { id?: string; name?: string }[] = json.data ?? json.models ?? [];
        return list
          .map((m) => modelInfo(m.id ?? m.name ?? '', provider === 'compatible' ? m.name : undefined))
          .filter((m) => m.id && (provider !== 'openai' || relevantOpenAiModel(m.id)))
          .sort(provider === 'openai' ? byRecency : (a, b) => a.name.localeCompare(b.name));
      } catch (e) {
        throw e instanceof HttpError ? describeHttpError(e, label, model) : e;
      }
    },
  };
}

function anthropicClient(model: string, opts: ClientOptions): AiClient {
  const label = 'Anthropic';
  const base = (opts.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers = { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' };
  return {
    label,
    async complete(req) {
      try {
        const json = await postJson(
          opts.fetchFn,
          `${base}/v1/messages`,
          headers,
          {
            model,
            max_tokens: 8192,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
            tools: [{ name: 'submit_result', description: 'Записати результат аналізу судового рішення', input_schema: req.schema }],
            tool_choice: { type: 'tool', name: 'submit_result' },
          },
          opts,
          req.signal,
        );
        const block = (json.content ?? []).find((b: { type: string }) => b.type === 'tool_use');
        if (block?.input && typeof block.input === 'object') return block.input as Record<string, unknown>;
        const text = (json.content ?? []).map((b: { text?: string }) => b.text ?? '').join('');
        if (json.stop_reason === 'max_tokens') throw new Error(`${label}: відповідь обірвано через ліміт токенів`);
        return parseJsonLoose(text);
      } catch (e) {
        throw e instanceof HttpError ? describeHttpError(e, label, model) : e;
      }
    },
    async listModels(signal) {
      try {
        const json = await getJson(opts.fetchFn, `${base}/v1/models?limit=1000`, headers, signal);
        const list: { id: string; display_name?: string; created_at?: string }[] = json.data ?? [];
        return list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).map((m) => modelInfo(m.id, m.display_name));
      } catch (e) {
        throw e instanceof HttpError ? describeHttpError(e, label, model) : e;
      }
    },
  };
}

/** Перетворює JSON Schema на схему у форматі OpenAPI, яку розуміють старіші моделі Gemini. */
function toGeminiSchema(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof s.type === 'string') out.type = s.type.toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) {
    out.enum = s.enum;
    out.format = 'enum';
  }
  if (s.items) out.items = toGeminiSchema(s.items as Record<string, unknown>);
  if (s.properties) {
    const props = s.properties as Record<string, Record<string, unknown>>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(props);
  }
  if (s.required) out.required = s.required;
  return out;
}

function stripAdditional(s: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _drop, ...rest } = s;
  if (rest.properties) {
    rest.properties = Object.fromEntries(Object.entries(rest.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [k, stripAdditional(v)]));
  }
  if (rest.items) rest.items = stripAdditional(rest.items as Record<string, unknown>);
  return rest;
}

function geminiClient(model: string, opts: ClientOptions): AiClient {
  const label = 'Google Gemini';
  const base = (opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const name = model.replace(/^models\//, '');
  const headers = { 'x-goog-api-key': opts.apiKey };
  let legacySchema = false;
  return {
    label,
    async complete(req) {
      for (;;) {
        const generationConfig: Record<string, unknown> = { responseMimeType: 'application/json' };
        if (legacySchema) generationConfig.responseSchema = toGeminiSchema(req.schema as unknown as Record<string, unknown>);
        else generationConfig.responseJsonSchema = stripAdditional(req.schema as unknown as Record<string, unknown>);
        try {
          const json = await postJson(
            opts.fetchFn,
            `${base}/models/${encodeURIComponent(name)}:generateContent`,
            headers,
            {
              systemInstruction: { parts: [{ text: req.system }] },
              contents: [{ role: 'user', parts: [{ text: req.user }] }],
              generationConfig,
            },
            opts,
            req.signal,
          );
          if (json.promptFeedback?.blockReason) throw new Error(`${label}: запит заблоковано (${json.promptFeedback.blockReason})`);
          const cand = json.candidates?.[0];
          const text = (cand?.content?.parts ?? []).map((p: { text?: string; thought?: boolean }) => (p.thought ? '' : p.text ?? '')).join('');
          if (!text) throw new Error(`${label}: порожня відповідь (finishReason: ${cand?.finishReason ?? '—'})`);
          return parseJsonLoose(text);
        } catch (e) {
          if (e instanceof HttpError && e.status === 400 && !legacySchema && /responseJsonSchema|response_json_schema|Unknown name/i.test(e.body)) {
            legacySchema = true;
            continue;
          }
          throw e instanceof HttpError ? describeHttpError(e, label, model) : e;
        }
      }
    },
    async listModels(signal) {
      try {
        const json = await getJson(opts.fetchFn, `${base}/models?pageSize=1000`, headers, signal);
        const list: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] = json.models ?? [];
        return list
          .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => modelInfo(m.name.replace(/^models\//, ''), m.displayName))
          .filter((m) => relevantGeminiModel(m.id))
          .sort(byRecency);
      } catch (e) {
        throw e instanceof HttpError ? describeHttpError(e, label, model) : e;
      }
    },
  };
}

export function createClient(provider: ProviderId, model: string, opts: ClientOptions): AiClient {
  switch (provider) {
    case 'openai':
    case 'compatible':
      return openAiClient(provider, model, opts);
    case 'anthropic':
      return anthropicClient(model, opts);
    case 'gemini':
      return geminiClient(model, opts);
  }
}
