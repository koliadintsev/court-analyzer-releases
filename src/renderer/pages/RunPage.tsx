import { useEffect, useMemo, useState } from 'react';
import { enabledAiFields } from '../../engine/prompts';
import { PROVIDERS } from '../../shared/presets';
import { JUDGMENT_FORMS, JUSTICE_KINDS, REVIEW_URL, STATUS_LABELS } from '../../shared/registry';
import type { DecisionRecord, RecordStatus, StageId } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../state';
import { Card, Modal, PageHeader, Progress, formatBytes, formatDateTime, plural } from '../ui';

const STAGES: { id: StageId; title: string }[] = [
  { id: 'registry', title: 'Пошук у відкритих даних реєстру' },
  { id: 'texts', title: 'Завантаження текстів рішень' },
  { id: 'filter', title: 'ШІ-фільтр за темою' },
  { id: 'extract', title: 'Витяг даних за допомогою ШІ' },
];

const STATUS_CLASS: Record<RecordStatus, string> = {
  pending: 'muted',
  not_found: 'warn',
  filtered_meta: 'muted',
  no_text: 'warn',
  too_short: 'muted',
  irrelevant: 'muted',
  relevant: 'info',
  done: 'ok',
  error: 'danger',
};

type Tab = 'done' | 'rejected' | 'all';

function shortDate(v?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

function valueText(v: unknown): string {
  return Array.isArray(v) ? v.join('; ') : v === undefined || v === null ? '' : String(v);
}

function RecordDrawer({ rec, onClose }: { rec: DecisionRecord; onClose: () => void }) {
  const { profile } = useApp();
  const [text, setText] = useState<string | null>(null);
  const fields = enabledAiFields(profile);
  const m = rec.meta;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && text === null && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, text]);
  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <div className="hint">Рішення № {rec.docId}</div>
            <h2>{m?.cause_num ? `Справа № ${m.cause_num}` : 'Рішення'}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          <div className="row">
            <span className={`status ${STATUS_CLASS[rec.status]}`}>{STATUS_LABELS[rec.status]}</span>
            {rec.textLength !== undefined && <span className="hint">текст: {rec.textLength.toLocaleString('uk-UA')} симв.</span>}
          </div>
          {rec.reason && rec.status !== 'done' && <p className="reason">{rec.reason}</p>}
          {m && (
            <dl className="kv">
              <dt>Дата рішення</dt>
              <dd>{shortDate(m.adjudication_date)}</dd>
              <dt>Форма</dt>
              <dd>{JUDGMENT_FORMS[m.judgment_code] ?? m.judgment_code}</dd>
              <dt>Судочинство</dt>
              <dd>{JUSTICE_KINDS[m.justice_kind] ?? m.justice_kind}</dd>
              <dt>Суддя</dt>
              <dd>{m.judge}</dd>
            </dl>
          )}
          {rec.relevance && (
            <>
              <h3>ШІ-фільтр</h3>
              <p>{rec.relevance.reason}</p>
            </>
          )}
          {rec.data && (
            <>
              <h3>Витягнуті дані</h3>
              <dl className="kv wide">
                {fields.map((f) => (
                  <div key={f.id} className="kv-row">
                    <dt>{f.title}</dt>
                    <dd>{valueText(rec.data?.[f.id])}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          <div className="row">
            <button className="btn" onClick={() => void api().openExternal(REVIEW_URL + rec.docId)}>
              Відкрити в реєстрі ↗
            </button>
            {rec.textLength !== undefined && (
              <button className="btn" onClick={async () => setText(await api().getText(rec.docId))}>
                Показати текст рішення
              </button>
            )}
          </div>
        </div>
      </aside>
      {text !== null && (
        <Modal title={`Текст рішення № ${rec.docId}`} onClose={() => setText(null)}>
          <pre className="decision-text">{text || 'Текст не знайдено в кеші.'}</pre>
        </Modal>
      )}
    </div>
  );
}

export function RunPage() {
  const { ids, profile, settings, run, startRun, runs, setPage, guard, toast } = useApp();
  const [tab, setTab] = useState<Tab>('done');
  const [selected, setSelected] = useState<DecisionRecord | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const shownRun = run.runId ? runs.find((r) => r.id === run.runId) : undefined;

  const f = profile.filters;
  const useFilter = f.aiFilterEnabled && f.aiCriterion.trim().length > 0;
  const aiFields = enabledAiFields(profile);
  const useExtract = profile.extraction.enabled && aiFields.length > 0;
  const keyMissing = (p: keyof typeof PROVIDERS) => !settings.keys[p] && p !== 'compatible';

  const problems: { text: string; page?: 'input' | 'ai' | 'fields' }[] = [];
  if (!ids.length) problems.push({ text: 'Перелік рішень порожній.', page: 'input' });
  if (useFilter && keyMissing(settings.ai.filter.provider)) problems.push({ text: `Не задано API-ключ ${PROVIDERS[settings.ai.filter.provider].title} для ШІ-фільтра.`, page: 'ai' });
  if (useExtract && keyMissing(settings.ai.extract.provider)) problems.push({ text: `Не задано API-ключ ${PROVIDERS[settings.ai.extract.provider].title} для витягу даних.`, page: 'ai' });
  if (!profile.columns.some((c) => c.enabled)) problems.push({ text: 'Не вибрано жодної колонки таблиці.', page: 'fields' });

  const records = useMemo(() => run.order.map((id) => run.records[id]).filter(Boolean), [run.order, run.records]);
  const counts = useMemo(() => {
    const c: Partial<Record<RecordStatus, number>> = {};
    records.forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
    return c;
  }, [records]);
  const doneCount = counts.done ?? 0;
  const rejected = records.filter((r) => r.status !== 'done' && r.status !== 'pending' && r.status !== 'relevant');
  const shown = tab === 'done' ? records.filter((r) => r.status === 'done') : tab === 'rejected' ? rejected : records;
  const hasResults = records.length > 0;
  // Додаткові колонки таблиці: перші поля ШІ або (без витягу даних) форма рішення й суддя.
  const extras: { title: string; value: (r: DecisionRecord) => string }[] =
    tab !== 'done'
      ? [{ title: 'Причина', value: (r) => r.reason ?? '' }]
      : useExtract
        ? aiFields.slice(0, 2).map((f) => ({ title: f.title, value: (r) => valueText(r.data?.[f.id]) }))
        : [
            { title: 'Форма', value: (r) => (r.meta ? JUDGMENT_FORMS[r.meta.judgment_code] ?? r.meta.judgment_code : '') },
            { title: 'Суддя', value: (r) => r.meta?.judge ?? '' },
          ];

  const doExport = async () => {
    if (!run.runId) return;
    const path = await guard(() => api().exportRun(run.runId!));
    if (path) {
      setExported(path);
      toast('Файл Excel збережено', 'ok');
    }
  };

  return (
    <>
      <PageHeader
        title="Запуск і результати"
        lead={!run.running && shownRun ? `Показано результати запуску від ${formatDateTime(shownRun.startedAt)} (профіль «${shownRun.profileName}»).` : undefined}
        actions={
          runs.length > 0 &&
          !run.running && (
            <button className="btn" onClick={() => setPage('history')}>
              🕘 Історія запусків ({runs.length})
            </button>
          )
        }
      />

      <Card>
        <div className="run-summary">
          <div className="summary-grid">
            <div>
              <div className="hint">Рішень у переліку</div>
              <div className="big">{ids.length}</div>
            </div>
            <div>
              <div className="hint">Профіль</div>
              <div>{profile.name}</div>
            </div>
            <div>
              <div className="hint">ШІ-фільтр</div>
              <div>{useFilter ? settings.ai.filter.model : 'вимкнено'}</div>
            </div>
            <div>
              <div className="hint">Витяг даних</div>
              <div>{useExtract ? `${settings.ai.extract.model}, ${aiFields.length} ${plural(aiFields.length, 'поле', 'поля', 'полів')}` : 'вимкнено'}</div>
            </div>
          </div>
          <div className="run-buttons">
            {run.running ? (
              <button className="btn danger big" onClick={() => void api().stopRun()}>
                ■ Зупинити
              </button>
            ) : (
              <button className="btn primary big" disabled={problems.length > 0} onClick={() => (setExported(null), setTab('done'), void startRun())}>
                ▶ Запустити обробку
              </button>
            )}
          </div>
        </div>
        {problems.map((p) => (
          <div key={p.text} className="notice warn">
            {p.text}{' '}
            {p.page && (
              <a href="#" onClick={(e) => (e.preventDefault(), setPage(p.page!))}>
                Виправити →
              </a>
            )}
          </div>
        ))}
        {!run.running && !hasResults && problems.length === 0 && (
          <p className="hint">
            Перший запуск завантажить архів відкритих даних реєстру за потрібні роки (~330 МБ на рік) — це може зайняти кілька хвилин. Далі архіви, тексти та відповіді ШІ беруться з кешу, тож перерваний запуск можна просто
            повторити.
          </p>
        )}
      </Card>

      {(run.running || Object.keys(run.stages).length > 0) && (
        <Card title="Перебіг обробки">
          <div className="stages">
            {STAGES.map((s, idx) => {
              const st = run.stages[s.id];
              const current = STAGES.findIndex((x) => x.id === run.activeStage);
              const active = run.running && idx === current;
              const complete = !!st && (idx < current || (!run.running && !run.error && !run.summary?.cancelled));
              let status = run.running ? 'очікує' : 'не виконувався';
              if (complete) status = 'готово';
              else if (st?.total) {
                if (st.unit === 'fraction') status = `${Math.round((st.done / st.total) * 100)}%`;
                else if (st.unit === 'bytes') status = `${formatBytes(st.done)} / ${formatBytes(st.total)}`;
                else status = `${st.done} / ${st.total}`;
              } else if (st) status = active ? '…' : 'зупинено';
              return (
                <div key={s.id} className={`stage ${active ? 'active' : ''} ${st ? '' : 'idle'}`}>
                  <div className="stage-head">
                    <span className="stage-title">
                      {active ? <span className="spinner dark" /> : complete ? '✓' : '○'} {st?.label ?? s.title}
                    </span>
                    <span className="hint">{status}</span>
                  </div>
                  {st && (active || st.total > 0 || complete) && <Progress done={complete ? 1 : st.done} total={complete ? 1 : st.total} indeterminate={active && !st.total} />}
                  {active && st?.detail && <div className="hint">{st.detail}</div>}
                </div>
              );
            })}
          </div>
          {run.error && <div className="notice error">{run.error}</div>}
          {run.summary?.cancelled && <div className="notice warn">Обробку зупинено. Повторний запуск продовжить з місця зупинки.</div>}
          <button className="link-btn" onClick={() => setShowLog(!showLog)}>
            {showLog ? 'Сховати журнал' : `Показати журнал (${run.logs.length})`}
          </button>
          {showLog && (
            <div className="log">
              {run.logs.map((l, i) => (
                <div key={i} className={`log-line ${l.level}`}>
                  <span className="log-time">{new Date(l.time).toLocaleTimeString('uk-UA')}</span> {l.message}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {hasResults && (
        <Card
          title="Результати"
          actions={
            <>
              <button className="btn primary" disabled={run.running || !run.runId} onClick={() => void doExport()}>
                ⬇ Зберегти в Excel…
              </button>
            </>
          }
        >
          {exported && (
            <div className="notice ok">
              Збережено: {exported}{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), void api().openPath(exported))}>
                Відкрити
              </a>{' '}
              ·{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), void api().showItem(exported))}>
                Показати в папці
              </a>
            </div>
          )}
          <div className="counters">
            {(Object.keys(STATUS_LABELS) as RecordStatus[])
              .filter((s) => counts[s])
              .map((s) => (
                <span key={s} className={`status ${STATUS_CLASS[s]}`}>
                  {STATUS_LABELS[s]}: {counts[s]}
                </span>
              ))}
          </div>
          <div className="tabs">
            <button className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>
              Оброблені ({doneCount})
            </button>
            <button className={tab === 'rejected' ? 'on' : ''} onClick={() => setTab('rejected')}>
              Відхилені та помилки ({rejected.length})
            </button>
            <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
              Усі ({records.length})
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Справа</th>
                  <th>Дата</th>
                  <th>Статус</th>
                  {extras.map((x) => (
                    <th key={x.title}>{x.title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 1000).map((r) => (
                  <tr key={r.docId} onClick={() => setSelected(r)}>
                    <td className="mono">{r.docId}</td>
                    <td>{r.meta?.cause_num ?? ''}</td>
                    <td>{shortDate(r.meta?.adjudication_date)}</td>
                    <td>
                      <span className={`status ${STATUS_CLASS[r.status]}`}>{STATUS_LABELS[r.status]}</span>
                    </td>
                    {extras.map((x) => (
                      <td key={x.title} className="clip">
                        {x.value(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <div className="empty">{run.running ? 'Результати з’являтимуться тут під час обробки.' : 'Немає рішень у цій категорії.'}</div>}
          </div>
          <p className="hint">Натисніть на рядок, щоб переглянути деталі.</p>
        </Card>
      )}

      {selected && <RecordDrawer rec={run.records[selected.docId] ?? selected} onClose={() => setSelected(null)} />}
    </>
  );
}
