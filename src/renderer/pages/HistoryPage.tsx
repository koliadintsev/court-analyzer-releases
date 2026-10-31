import { useEffect, useState } from 'react';
import { STATUS_LABELS } from '../../shared/registry';
import type { RecordStatus, RunInfo } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../state';
import { Card, PageHeader, formatDateTime } from '../ui';

function duration(r: RunInfo): string {
  if (!r.finishedAt) return '';
  const s = Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000);
  return s < 60 ? `${s} с` : s < 3600 ? `${Math.round(s / 60)} хв` : `${(s / 3600).toFixed(1)} год`;
}

function outcome(r: RunInfo): { text: string; cls: string } {
  if (r.error) return { text: 'з помилкою', cls: 'danger' };
  if (r.cancelled) return { text: 'зупинено', cls: 'warn' };
  return { text: 'завершено', cls: 'ok' };
}

const REJECTED: RecordStatus[] = ['not_found', 'filtered_meta', 'no_text', 'too_short', 'irrelevant'];

export function HistoryPage() {
  const { runs, refreshRuns, loadRun, setPage, guard, toast, run, confirm } = useApp();
  const [exported, setExported] = useState<string | null>(null);

  useEffect(() => void refreshRuns(), [refreshRuns]);

  const open = async (id: string) => {
    await loadRun(id);
    setPage('run');
  };

  return (
    <>
      <PageHeader title="Історія запусків" lead="Усі попередні обробки зберігаються в робочій папці програми. Будь-яку можна відкрити для перегляду або знову зберегти в Excel." />

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

      <Card>
        {runs.length === 0 ? (
          <div className="empty">Ще не було жодного запуску.</div>
        ) : (
          <div className="table-wrap full">
            <table className="table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Профіль</th>
                  <th>Рішень</th>
                  <th>Оброблено</th>
                  <th>Відхилено</th>
                  <th>Помилки</th>
                  <th>Стан</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const o = outcome(r);
                  const rejected = REJECTED.reduce((n, s) => n + (r.counts[s] ?? 0), 0);
                  return (
                    <tr key={r.id} onClick={() => void open(r.id)} title="Відкрити результати">
                      <td>
                        {formatDateTime(r.startedAt)}
                        <div className="hint">{duration(r)}</div>
                      </td>
                      <td>{r.profileName}</td>
                      <td>{r.total}</td>
                      <td>
                        <b>{r.done}</b>
                      </td>
                      <td title={REJECTED.filter((s) => r.counts[s]).map((s) => `${STATUS_LABELS[s]}: ${r.counts[s]}`).join('\n')}>{rejected}</td>
                      <td>{r.counts.error ?? 0}</td>
                      <td>
                        <span className={`status ${o.cls}`}>{o.text}</span>
                      </td>
                      <td className="actions" onClick={(e) => e.stopPropagation()}>
                        <button className="btn small" onClick={() => void open(r.id)}>
                          Відкрити
                        </button>
                        <button
                          className="btn small"
                          onClick={async () => {
                            const path = await guard(() => api().exportRun(r.id));
                            if (path) setExported(path);
                          }}
                        >
                          Excel
                        </button>
                        <button
                          className="btn small danger"
                          disabled={run.running}
                          onClick={async () => {
                            const ok = await confirm({
                              title: 'Видалити запуск?',
                              message: `Результати запуску від ${formatDateTime(r.startedAt)} (${r.total} рішень) буде видалено з історії. Тексти рішень і відповіді ШІ залишаться в кеші.`,
                              okText: 'Видалити',
                              danger: true,
                            });
                            if (!ok) return;
                            await guard(() => api().deleteRun(r.id));
                            await refreshRuns();
                            toast('Запуск видалено', 'ok');
                          }}
                        >
                          Видалити
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
