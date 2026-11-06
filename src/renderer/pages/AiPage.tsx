import { useCallback, useEffect, useState } from 'react';
import { MODEL_SUGGESTIONS, PROVIDERS } from '../../shared/presets';
import type { AiSettings, ModelInfo, ProviderId, StageModel } from '../../shared/types';
import { api, errorMessage } from '../api';
import { useApp } from '../state';
import { Card, CommitInput, Field, PageHeader } from '../ui';

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
const MANUAL = '__manual__';

type Models = Partial<Record<ProviderId, ModelInfo[]>>;

/** Найкраща модель зі списку для етапу: швидка для фільтра, потужна для витягу. */
function pickModel(list: ModelInfo[] | undefined, light: boolean): string | undefined {
  if (!list?.length) return undefined;
  return (list.find((m) => m.light === light) ?? list[0]).id;
}

function StagePicker(props: {
  title: string;
  hint: string;
  value: StageModel;
  models: Models;
  loading: boolean;
  light: boolean;
  hasKey: boolean;
  onChange: (v: StageModel) => void;
}) {
  const { title, hint, value, models, loading, light, hasKey, onChange } = props;
  const list = models[value.provider] ?? [];
  const known = list.some((m) => m.id === value.model);
  const [manual, setManual] = useState(false);
  const showSelect = list.length > 0 && !manual;
  const groups = [
    { label: light ? 'Швидкі й недорогі (рекомендовано)' : 'Швидкі й недорогі', items: list.filter((m) => m.light) },
    { label: light ? 'Потужні' : 'Потужні (рекомендовано)', items: list.filter((m) => !m.light) },
  ];
  if (!light) groups.reverse();

  return (
    <div className="stage-picker">
      <div>
        <div className="field-label">{title}</div>
        <div className="hint">{hint}</div>
      </div>
      <div className="stack-tight">
        <div className="row">
          <select
            value={value.provider}
            onChange={(e) => {
              const provider = e.target.value as ProviderId;
              setManual(false);
              onChange({ provider, model: pickModel(models[provider], light) ?? MODEL_SUGGESTIONS[provider][light ? 0 : 1] ?? MODEL_SUGGESTIONS[provider][0] ?? '' });
            }}
          >
            {PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {PROVIDERS[p].title}
              </option>
            ))}
          </select>
          {showSelect ? (
            <select
              className="model-input"
              value={known ? value.model : value.model ? `custom:${value.model}` : ''}
              onChange={(e) => (e.target.value === MANUAL ? setManual(true) : onChange({ ...value, model: e.target.value }))}
            >
              {!known && value.model && <option value={`custom:${value.model}`}>{value.model} (немає в списку)</option>}
              {groups
                .filter((g) => g.items.length)
                .map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.items.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name !== m.id ? `${m.name} — ${m.id}` : m.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              <option value={MANUAL}>Інша модель — ввести назву…</option>
            </select>
          ) : (
            <CommitInput className="model-input" value={value.model} placeholder="назва моделі" onCommit={(model) => onChange({ ...value, model: model.trim() })} />
          )}
        </div>
        <div className="hint">
          {loading
            ? 'Завантажую список доступних моделей…'
            : showSelect
              ? `Доступно моделей: ${list.length}.`
              : list.length
                ? (
                  <a href="#" onClick={(e) => (e.preventDefault(), setManual(false))}>
                    Вибрати зі списку доступних моделей
                  </a>
                )
                : hasKey || value.provider === 'compatible'
                  ? 'Список моделей недоступний — введіть назву моделі вручну.'
                  : 'Збережіть API-ключ нижче — список доступних моделей з’явиться автоматично.'}
        </div>
      </div>
    </div>
  );
}

function KeyRow({ provider, loading, count, onSaved, onCheck }: { provider: ProviderId; loading: boolean; count?: number; onSaved: () => void; onCheck: () => Promise<string | null> }) {
  const { settings, setSettings, guard, confirm } = useApp();
  const [value, setValue] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const info = PROVIDERS[provider];
  const has = settings.keys[provider];

  return (
    <div className="key-row">
      <div className="key-head">
        <b>{info.title}</b>
        <span className={`status ${has ? 'ok' : 'muted'}`}>{has ? 'ключ збережено' : 'ключа немає'}</span>
        {has && count !== undefined && <span className="hint">моделей: {count}</span>}
        {info.keyUrl && (
          <a href="#" className="hint" onClick={(e) => (e.preventDefault(), void api().openExternal(info.keyUrl))}>
            де отримати ключ ↗
          </a>
        )}
      </div>
      {provider === 'compatible' && (
        <Field label="Адреса API (Base URL)" hint="Наприклад: https://openrouter.ai/api/v1 або http://localhost:11434/v1 (Ollama)">
          <CommitInput value={settings.ai.compatibleBaseUrl} onCommit={async (v) => setSettings(await api().updateSettings({ ai: { ...settings.ai, compatibleBaseUrl: v.trim() } }))} />
        </Field>
      )}
      <div className="row">
        <input type="password" className="key-input" value={value} placeholder={has ? '•••••••• (введіть новий, щоб замінити)' : info.keyHint} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        <button
          className="btn primary"
          disabled={!value.trim()}
          onClick={async () => {
            const s = await guard(() => api().setApiKey(provider, value), 'Ключ збережено');
            if (s) {
              setSettings(s);
              setValue('');
              setCheck(null);
              onSaved();
            }
          }}
        >
          Зберегти
        </button>
        <button
          className="btn"
          disabled={loading || (!has && provider !== 'compatible')}
          onClick={async () => {
            const err = await onCheck();
            setCheck(err ? { ok: false, text: err } : { ok: true, text: 'Ключ працює, список моделей оновлено.' });
          }}
        >
          {loading ? 'Перевірка…' : 'Перевірити'}
        </button>
        {has && (
          <button
            className="btn danger"
            onClick={async () => {
              if (!(await confirm({ title: `Видалити ключ ${info.title}?`, message: 'Ключ буде видалено з цього комп’ютера. Щоб знову користуватися цим провайдером, його доведеться ввести ще раз.', okText: 'Видалити', danger: true }))) return;
              const s = await guard(() => api().setApiKey(provider, null));
              if (s) setSettings(s);
            }}
          >
            Видалити
          </button>
        )}
      </div>
      {check && <div className={`notice ${check.ok ? 'ok' : 'error'}`}>{check.text}</div>}
    </div>
  );
}

export function AiPage() {
  const { settings, setSettings, init } = useApp();
  const [models, setModels] = useState<Models>(init.models);
  const [loading, setLoading] = useState<Partial<Record<ProviderId, boolean>>>({});
  const setAi = useCallback(async (patch: Partial<AiSettings>) => setSettings(await api().updateSettings({ ai: { ...settings.ai, ...patch } })), [settings.ai, setSettings]);

  /** Запитує список моделей; повертає текст помилки або null. */
  const load = useCallback(async (provider: ProviderId, refresh: boolean): Promise<string | null> => {
    setLoading((l) => ({ ...l, [provider]: true }));
    try {
      const list = await api().listModels(provider, refresh);
      setModels((m) => ({ ...m, [provider]: list }));
      return null;
    } catch (e) {
      return errorMessage(e);
    } finally {
      setLoading((l) => ({ ...l, [provider]: false }));
    }
  }, []);

  // Автоматично підтягуємо моделі провайдерів, для яких є ключ.
  useEffect(() => {
    for (const p of PROVIDER_IDS) if (settings.keys[p] || (p === 'compatible' && (settings.ai.filter.provider === p || settings.ai.extract.provider === p))) void load(p, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Якщо вибрана модель — лише підказка за замовчуванням і її немає в списку, обираємо відповідну з доступних.
  useEffect(() => {
    const fix = (stage: StageModel, light: boolean): StageModel | undefined => {
      const list = models[stage.provider];
      if (!list?.length || list.some((m) => m.id === stage.model)) return undefined;
      if (stage.model && !MODEL_SUGGESTIONS[stage.provider].includes(stage.model)) return undefined;
      const id = pickModel(list, light);
      return id ? { ...stage, model: id } : undefined;
    };
    const filter = fix(settings.ai.filter, true);
    const extract = fix(settings.ai.extract, false);
    if (filter || extract) void setAi({ ...(filter && { filter }), ...(extract && { extract }) });
  }, [models, settings.ai.filter, settings.ai.extract, setAi]);

  return (
    <>
      <PageHeader title="Налаштування ШІ" lead="Оберіть провайдера і моделі та додайте свій API-ключ. Оплата за використання ШІ здійснюється напряму провайдеру за вашим ключем." />

      <Card title="Моделі">
        <StagePicker
          title="Для ШІ-фільтра"
          hint="Читає кожне рішення і вирішує, чи воно стосується теми. Підійде швидка й недорога модель."
          value={settings.ai.filter}
          models={models}
          loading={Boolean(loading[settings.ai.filter.provider])}
          light
          hasKey={settings.keys[settings.ai.filter.provider]}
          onChange={(filter) => void setAi({ filter })}
        />
        <StagePicker
          title="Для витягу даних"
          hint="Заповнює поля таблиці. Краще обрати потужнішу модель."
          value={settings.ai.extract}
          models={models}
          loading={Boolean(loading[settings.ai.extract.provider])}
          light={false}
          hasKey={settings.keys[settings.ai.extract.provider]}
          onChange={(extract) => void setAi({ extract })}
        />
      </Card>

      <Card title="API-ключі" hint={settings.keysEncrypted ? 'Ключі зберігаються лише на цьому комп’ютері в зашифрованому вигляді (засобами операційної системи) і передаються тільки відповідному провайдеру.' : 'Увага: шифрування недоступне — ключі зберігаються у файлі в робочій папці програми.'}>
        {PROVIDER_IDS.map((p) => (
          <KeyRow key={p} provider={p} loading={Boolean(loading[p])} count={models[p]?.length} onSaved={() => void load(p, true)} onCheck={() => load(p, true)} />
        ))}
        <div className="notice info">Тексти судових рішень надсилаються обраному провайдеру ШІ для аналізу. Судові рішення в ЄДРСР є відкритими, але враховуйте політику вашої організації щодо використання хмарних ШІ-сервісів.</div>
      </Card>

      <Card title="Продуктивність і обмеження">
        <div className="form-grid">
          <Field label="Паралельних запитів до ШІ" hint="Більше — швидше, але можна впертися в ліміти провайдера (помилка 429).">
            <CommitInput type="number" min={1} max={20} value={settings.ai.concurrency} onCommit={(v) => void setAi({ concurrency: Math.min(20, Math.max(1, Number(v) || 1)) })} />
          </Field>
          <Field label="Максимум символів тексту в одному запиті" hint="Довші рішення ШІ-фільтр перевіряє частинами, а для витягу даних середина тексту скорочується.">
            <CommitInput type="number" min={20000} step={10000} value={settings.ai.maxInputChars} onCommit={(v) => void setAi({ maxInputChars: Math.max(20000, Number(v) || 300000) })} />
          </Field>
          <Field label="Паралельних завантажень текстів рішень">
            <CommitInput
              type="number"
              min={1}
              max={10}
              value={settings.textConcurrency}
              onCommit={async (v) => setSettings(await api().updateSettings({ textConcurrency: Math.min(10, Math.max(1, Number(v) || 1)) }))}
            />
          </Field>
        </div>
      </Card>
    </>
  );
}
