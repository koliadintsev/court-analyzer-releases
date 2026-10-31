import { useEffect, useState } from 'react';
import type { CatalogView, SourceOrigin } from '../../shared/types';
import { api, type CatalogProgress } from '../api';
import { useApp } from '../state';
import { Card, PageHeader, Progress, formatBytes, formatDateTime } from '../ui';

const ORIGIN: Record<SourceOrigin, string> = { dsa: 'сайт ДСА', 'data.gov.ua': 'data.gov.ua', builtin: 'вбудоване', custom: 'додано вручну', file: 'файл на диску' };

export function RegistryPage() {
  const { guard, run, confirm } = useApp();
  const [cat, setCat] = useState<CatalogView | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CatalogProgress | null>(null);
  const [url, setUrl] = useState('');
  const [year, setYear] = useState('');

  useEffect(() => {
    void guard(() => api().getCatalog()).then((c) => c && setCat(c));
    return api().onCatalogProgress((p) => setProgress(p.finished ? null : p));
  }, [guard]);

  const act = async (fn: () => Promise<CatalogView>, ok?: string) => {
    setBusy(true);
    const c = await guard(fn, ok);
    if (c) setCat(c);
    setBusy(false);
  };

  const cy = new Date().getFullYear();

  return (
    <>
      <PageHeader
        title="Дані реєстру"
        lead="Програма використовує відкриті дані Єдиного державного реєстру судових рішень: щорічні архіви з переліком усіх рішень і посиланнями на їхні тексти. Набори за нові роки знаходяться автоматично через портал data.gov.ua."
        actions={
          <button className="btn" disabled={busy} onClick={() => void act(() => api().getCatalog(true), 'Перелік наборів оновлено')}>
            ⟳ Оновити перелік наборів
          </button>
        }
      />

      {cat?.warnings.map((w) => (
        <div key={w} className="notice warn">
          {w}
        </div>
      ))}

      <Card
        title="Річні набори"
        hint={
          <>
            Перелік оновлено: {formatDateTime(cat?.updatedAt)}. Архіви завантажуються автоматично під час обробки — лише за ті роки, до яких належать рішення з вашого переліку. Завантажені архіви раз на тиждень
            автоматично звіряються з сервером і оновлюються, якщо змінилися (архів поточного року оновлюється на сервері щодня).
          </>
        }
      >
        {!cat ? (
          <div className="empty">
            <span className="spinner dark" /> Завантаження…
          </div>
        ) : (
          <div className="table-wrap full">
            <table className="table">
              <thead>
                <tr>
                  <th>Рік</th>
                  <th>Джерела</th>
                  <th>Архів на диску</th>
                  <th>ID рішень від</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cat.years.map((y) => (
                  <tr key={y.year} className="no-hover">
                    <td>
                      <b>{y.year}</b>
                      {y.year === cy && <span className="hint"> · поточний</span>}
                    </td>
                    <td className="hint">{y.sources.map((s) => ORIGIN[s.origin]).join(', ') || '—'}</td>
                    <td>
                      {progress?.year === y.year ? (
                        <div className="dl-progress">
                          <Progress done={progress.done} total={progress.total} />
                          <span className="hint">
                            {formatBytes(progress.done)} / {progress.total ? formatBytes(progress.total) : '…'}
                          </span>
                        </div>
                      ) : y.cache ? (
                        <span>
                          {formatBytes(y.cache.size)} <span className="hint">· {y.cache.local ? 'вибраний файл' : formatDateTime(y.cache.downloadedAt)}</span>
                          {y.cache.checkedAt && y.cache.checkedAt !== y.cache.downloadedAt && <div className="hint">звірено з сервером {formatDateTime(y.cache.checkedAt)}</div>}
                        </span>
                      ) : (
                        <span className="hint">не завантажено</span>
                      )}
                    </td>
                    <td className="mono hint">{y.minId ?? '—'}</td>
                    <td className="actions">
                      {progress?.year === y.year ? (
                        <button className="btn small" onClick={() => void api().cancelDownload()}>
                          Скасувати
                        </button>
                      ) : (
                        <>
                          {!y.cache?.local && (
                            <button className="btn small" disabled={busy || run.running || progress !== null} onClick={() => void act(() => api().downloadYear(y.year), `Архів за ${y.year} рік завантажено`)}>
                              {y.cache ? 'Оновити' : 'Завантажити'}
                            </button>
                          )}
                          {y.cache && !y.cache.local && (
                            <button className="btn small danger" disabled={busy || run.running} onClick={async () => {
                                const ok = await confirm({ title: `Видалити архів за ${y.year} рік?`, message: `Файл (${formatBytes(y.cache!.size)}) буде видалено з диска. За потреби програма завантажить його знову.`, okText: 'Видалити', danger: true });
                                if (ok) void act(() => api().deleteYearCache(y.year));
                              }}
                            >
                              Видалити
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Додати набір вручну"
        hint="Якщо набір за новий рік ще не знайдено автоматично або сайт недоступний. Підійде посилання на сторінку набору на сайті ДСА (dsa.court.gov.ua/dsa/inshe/oddata/…), на набір data.gov.ua або пряме посилання на ZIP-архів."
      >
        <div className="row">
          <input className="grow" value={url} placeholder="https://dsa.court.gov.ua/dsa/inshe/oddata/7636/" onChange={(e) => setUrl(e.target.value)} />
          <input className="year-input" value={year} placeholder="рік" inputMode="numeric" onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          <button
            className="btn primary"
            disabled={!url.trim() || busy}
            onClick={() =>
              void act(async () => {
                const c = await api().addCatalogUrl(url, year ? Number(year) : undefined);
                setUrl('');
                return c;
              }, 'Джерело додано')
            }
          >
            Додати посилання
          </button>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="hint">Або вкажіть архів, уже завантажений браузером (файл edrsr_data_РРРР.zip):</span>
          <button className="btn" disabled={busy} onClick={() => void act(() => api().addCatalogFile(year ? Number(year) : undefined))}>
            Вибрати ZIP-файл…
          </button>
        </div>
        {cat && cat.custom.length > 0 && (
          <ul className="custom-list">
            {cat.custom.map((c) => (
              <li key={c.id}>
                <b>{c.year}</b> · {c.origin === 'file' ? 'файл' : 'посилання'}: <span className="mono">{c.label}</span>
                <button className="icon-btn danger" title="Прибрати" onClick={() => void act(() => api().removeCatalogSource(c.id))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {cat && (
        <Card title="Робоча папка">
          <p className="hint">Тут зберігаються архіви реєстру, тексти рішень, кеш відповідей ШІ, налаштування та результати запусків.</p>
          <div className="row" style={{ margin: '8px 0 12px' }}>
            <span className="mono path">{cat.dataDir}</span>
            <button className="btn small" onClick={() => void api().openPath(cat.dataDir)}>
              Відкрити папку
            </button>
          </div>
          <div className="row">
            <span>
              Кеш текстів рішень: {cat.textCache.files} файлів, {formatBytes(cat.textCache.bytes)}
            </span>
            <button className="btn small" disabled={busy || run.running || !cat.textCache.files} onClick={async () => {
                const ok = await confirm({ title: 'Очистити кеш текстів?', message: `Буде видалено ${cat.textCache.files} збережених текстів рішень. Під час наступної обробки їх буде завантажено знову.`, okText: 'Очистити', danger: true });
                if (ok) void act(() => api().clearTexts());
              }}
            >
              Очистити
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
