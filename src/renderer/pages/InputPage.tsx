import { useEffect, useRef, useState } from 'react';
import { extractIdsFromText, uniqueIds } from '../../shared/ids';
import { api } from '../api';
import { useApp } from '../state';
import { Card, PageHeader, plural } from '../ui';

const SHOW = 300;

export function InputPage() {
  const { ids, setIds, setPage, toast, guard, run, confirm } = useApp();
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);

  const add = (found: string[], source: string) => {
    if (!found.length) {
      toast(`У ${source} не знайдено номерів рішень`, 'error');
      return;
    }
    const merged = uniqueIds([...ids, ...found]);
    const added = merged.length - ids.length;
    setIds(merged);
    toast(`Додано ${added} ${plural(added, 'рішення', 'рішення', 'рішень')}${found.length > added ? ` (${found.length - added} вже були в переліку)` : ''}`, 'ok');
  };

  const addText = (value: string) => {
    add(extractIdsFromText(value), 'тексті');
    setText('');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const t = e.dataTransfer.getData('text');
    if (t) addText(t);
  };

  // Файли, перетягнуті у вікно програми (будь-куди), додаються до переліку.
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(
    () =>
      api().onFileDrop(async (paths) => {
        const r = await guard(() => api().parseIdsFiles(paths));
        if (r) addRef.current(r.ids, r.fileName ?? 'файлі');
      }),
    [guard],
  );

  return (
    <>
      <PageHeader
        title="Перелік рішень"
        lead={
          <>
            Знайдіть рішення на сайті{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), void api().openExternal('https://reyestr.court.gov.ua/'))}>
              reyestr.court.gov.ua
            </a>{' '}
            за ключовими словами, а потім додайте результати пошуку сюди будь-яким зі способів нижче.
          </>
        }
      />

      <div className="howto">
        <div className="howto-item">
          <b>1. Скопіювати сторінку</b>
          На сторінці результатів пошуку натисніть <kbd>Ctrl</kbd>+<kbd>A</kbd>, <kbd>Ctrl</kbd>+<kbd>C</kbd> і вставте текст у поле нижче.
        </div>
        <div className="howto-item">
          <b>2. Зберегти сторінку</b>
          Натисніть <kbd>Ctrl</kbd>+<kbd>S</kbd> на сторінці результатів і завантажте збережений HTML-файл (можна кілька сторінок).
        </div>
        <div className="howto-item">
          <b>3. Файл з номерами</b>
          TXT, CSV або XLSX з номерами рішень чи посиланнями на них (наприклад, колонка <code>doc_id</code>).
        </div>
      </div>

      <Card title="Додати рішення">
        <div className={`dropzone ${drag ? 'drag' : ''}`} onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <textarea
            className="paste"
            value={text}
            placeholder="Вставте сюди текст сторінки результатів пошуку, посилання на рішення (https://reyestr.court.gov.ua/Review/…) або номери рішень — по одному в рядку. Можна також перетягнути сюди файл."
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const t = e.clipboardData.getData('text');
              if (t.length > 200 || /Review\/\d+/.test(t)) {
                e.preventDefault();
                addText(t);
              }
            }}
          />
          <div className="row">
            <button className="btn primary" disabled={!text.trim()} onClick={() => addText(text)}>
              Додати з тексту
            </button>
            <button
              className="btn"
              onClick={async () => {
                const r = await guard(() => api().pickIdsFile());
                if (r) add(r.ids, r.fileName ?? 'файлі');
              }}
            >
              Завантажити файл…
            </button>
            <span className="hint">Великі фрагменти тексту обробляються одразу під час вставлення.</span>
          </div>
        </div>
      </Card>

      <Card
        title={`У переліку: ${ids.length} ${plural(ids.length, 'рішення', 'рішення', 'рішень')}`}
        hint="Номери рішень у Єдиному державному реєстрі судових рішень. Натисніть ✕, щоб прибрати рішення з переліку."
        actions={
          ids.length > 0 && (
            <>
              <button className="btn small" onClick={() => void navigator.clipboard.writeText(ids.join('\n')).then(() => toast('Перелік скопійовано', 'ok'))}>
                Копіювати
              </button>
              <button className="btn small danger" disabled={run.running} onClick={async () => {
                  const ok = await confirm({ title: 'Очистити перелік?', message: `З переліку буде прибрано всі ${ids.length} ${plural(ids.length, 'рішення', 'рішення', 'рішень')}.`, okText: 'Очистити', danger: true });
                  if (ok) setIds([]);
                }}
              >
                Очистити
              </button>
            </>
          )
        }
      >
        {ids.length === 0 ? (
          <div className="empty">Перелік порожній — додайте рішення одним зі способів вище.</div>
        ) : (
          <div className="id-list">
            {ids.slice(0, SHOW).map((id) => (
              <span key={id} className="id-chip">
                <a href="#" onClick={(e) => (e.preventDefault(), void api().openExternal(`https://reyestr.court.gov.ua/Review/${id}`))} title="Відкрити в реєстрі">
                  {id}
                </a>
                <button className="x" title="Прибрати" onClick={() => setIds(ids.filter((x) => x !== id))}>
                  ✕
                </button>
              </span>
            ))}
            {ids.length > SHOW && <span className="hint">…і ще {ids.length - SHOW}</span>}
          </div>
        )}
      </Card>

      <div className="page-foot">
        <button className="btn primary" disabled={!ids.length} onClick={() => setPage('filters')}>
          Далі: фільтри →
        </button>
      </div>
    </>
  );
}
