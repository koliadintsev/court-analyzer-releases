import { buildFilterPrompt } from '../../engine/prompts';
import { INSTANCES, JUDGMENT_FORMS, JUSTICE_KINDS } from '../../shared/registry';
import type { ProfileFilters } from '../../shared/types';
import { useApp } from '../state';
import { Card, Chips, DateInput, Field, PageHeader, Toggle } from '../ui';

export function FiltersPage() {
  const { profile, updateProfile, setPage, settings } = useApp();
  const f = profile.filters;
  const set = (patch: Partial<ProfileFilters>) => updateProfile({ ...profile, filters: { ...f, ...patch } });

  return (
    <>
      <PageHeader title="Фільтри" lead="Спочатку рішення відсіюються за даними реєстру (швидко і безкоштовно), потім — за змістом за допомогою ШІ." />

      <Card title="Формальні фільтри" hint="Застосовуються до даних з реєстру. Якщо в групі нічого не вибрано — фільтр не діє.">
        <div className="form-grid">
          <Field label="Форма рішення" wide>
            <Chips options={JUDGMENT_FORMS} value={f.judgmentForms} onChange={(judgmentForms) => set({ judgmentForms })} />
          </Field>
          <Field label="Вид судочинства" wide>
            <Chips options={JUSTICE_KINDS} value={f.justiceKinds} onChange={(justiceKinds) => set({ justiceKinds })} />
          </Field>
          <Field label="Інстанція" wide>
            <Chips options={INSTANCES} value={f.instances} onChange={(instances) => set({ instances })} />
          </Field>
          <Field label="Дата ухвалення рішення — від">
            <DateInput value={f.dateFrom} onChange={(dateFrom) => set({ dateFrom })} />
          </Field>
          <Field label="до">
            <DateInput value={f.dateTo} onChange={(dateTo) => set({ dateTo })} />
          </Field>
          <Field label="Мінімальна довжина тексту, символів" hint="Короткі тексти — зазвичай процесуальні ухвали без аналізу суті спору.">
            <input type="number" min={0} step={500} value={f.minTextLength} onChange={(e) => set({ minTextLength: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
        </div>
      </Card>

      <Card title="ШІ-фільтр за темою" hint={`Модель: ${settings.ai.filter.model} (змінити — у «Налаштуваннях ШІ»).`}>
        <Toggle
          checked={f.aiFilterEnabled}
          onChange={(aiFilterEnabled) => set({ aiFilterEnabled })}
          label="Перевіряти за допомогою ШІ, чи справді рішення стосується теми"
          hint="Пошук у реєстрі за ключовими словами знаходить багато зайвого — ШІ прочитає кожне рішення і залишить лише релевантні."
        />
        {f.aiFilterEnabled && (
          <div className="stack">
            <Field label="Рішення має відповідати критерію:" hint="Опишіть тему своїми словами, як пояснили б колезі." wide>
              <textarea
                rows={3}
                value={f.aiCriterion}
                placeholder="наприклад: рішення стосується трансфертного ціноутворення або застосування статті 39 Податкового кодексу України"
                onChange={(e) => set({ aiCriterion: e.target.value })}
              />
            </Field>
            {!f.aiCriterion.trim() && <div className="notice warn">Критерій не заповнено — ШІ-фільтр не буде застосовано.</div>}
            <Field label="Додаткові вказівки (необов’язково)" hint="Наприклад, що вважати релевантним, а що ні." wide>
              <textarea rows={3} value={f.aiFilterInstructions} placeholder="наприклад: не вважай релевантними рішення, де ст. 39 ПКУ лише згадується в переліку норм" onChange={(e) => set({ aiFilterInstructions: e.target.value })} />
            </Field>
            <details className="prompt-preview">
              <summary>Показати повний текст інструкції для ШІ</summary>
              <pre>{buildFilterPrompt(profile)}</pre>
            </details>
          </div>
        )}
      </Card>

      <div className="page-foot">
        <button className="btn" onClick={() => setPage('input')}>
          ← Перелік рішень
        </button>
        <button className="btn primary" onClick={() => setPage('fields')}>
          Далі: поля таблиці →
        </button>
      </div>
    </>
  );
}
