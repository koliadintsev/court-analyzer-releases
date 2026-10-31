import { useState } from 'react';
import { buildExtractionPrompt, enabledAiFields } from '../../engine/prompts';
import { META_COLUMNS } from '../../shared/registry';
import type { AiField, Column, FieldType, ProfileExtraction } from '../../shared/types';
import { useApp } from '../state';
import { Card, Field, PageHeader, Toggle } from '../ui';

const TYPES: Record<FieldType, string> = {
  text: 'Короткий текст',
  long_text: 'Розгорнутий текст',
  list: 'Список',
  boolean: 'Так / ні',
  number: 'Число',
  date: 'Дата',
  enum: 'Вибір з варіантів',
};

function nextFieldId(columns: Column[]): string {
  const used = new Set(columns.flatMap((c) => (c.kind === 'ai' ? [c.field.id] : [])));
  let n = 1;
  while (used.has(`field_${n}`)) n++;
  return `field_${n}`;
}

function AiFieldEditor({ field, onChange }: { field: AiField; onChange: (f: AiField) => void }) {
  const [optionsText, setOptionsText] = useState((field.options ?? []).join('\n'));
  return (
    <div className="field-editor">
      <div className="form-grid">
        <Field label="Назва колонки">
          <input value={field.title} onChange={(e) => onChange({ ...field, title: e.target.value })} />
        </Field>
        <Field label="Тип значення">
          <select value={field.type} onChange={(e) => onChange({ ...field, type: e.target.value as FieldType })}>
            {Object.entries(TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Що має знайти ШІ" hint="Опишіть якомога конкретніше: що саме, в якій формі, що робити в спірних випадках." wide>
          <textarea rows={3} value={field.instruction} onChange={(e) => onChange({ ...field, instruction: e.target.value })} />
        </Field>
        {field.type === 'enum' && (
          <Field label="Допустимі варіанти (кожен з нового рядка)" wide>
            <textarea
              rows={4}
              value={optionsText}
              onChange={(e) => {
                setOptionsText(e.target.value);
                onChange({ ...field, options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) });
              }}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

export function FieldsPage() {
  const { profile, updateProfile, setPage, confirm } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const cols = profile.columns;
  const setCols = (columns: Column[]) => updateProfile({ ...profile, columns });
  const setExtraction = (patch: Partial<ProfileExtraction>) => updateProfile({ ...profile, extraction: { ...profile.extraction, ...patch } });
  const key = (c: Column) => (c.kind === 'meta' ? `meta:${c.id}` : `ai:${c.field.id}`);

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    const next = [...cols];
    [next[i], next[j]] = [next[j], next[i]];
    setCols(next);
  };
  const patch = (i: number, c: Column) => setCols(cols.map((x, k) => (k === i ? c : x)));

  const addField = () => {
    const field: AiField = { id: nextFieldId(cols), title: 'Нове поле', instruction: '', type: 'text' };
    const linkIdx = cols.findIndex((c) => c.kind === 'meta' && c.id === 'link');
    const next = [...cols];
    next.splice(linkIdx >= 0 ? linkIdx : next.length, 0, { kind: 'ai', enabled: true, field });
    setCols(next);
    setOpen(`ai:${field.id}`);
  };

  const aiCount = enabledAiFields(profile).length;
  const enabledCount = cols.filter((c) => c.enabled).length;

  return (
    <>
      <PageHeader
        title="Поля підсумкової таблиці"
        lead="Позначте колонки, які мають потрапити в Excel, і розставте їх у потрібному порядку. Колонки «з реєстру» беруться з відкритих даних, колонки «ШІ» заповнює модель за текстом рішення."
        actions={
          <button className="btn primary" onClick={addField}>
            + Додати поле ШІ
          </button>
        }
      />

      <Card>
        <Toggle
          checked={profile.extraction.enabled}
          onChange={(enabled) => setExtraction({ enabled })}
          label="Витягати дані з тексту рішень за допомогою ШІ"
          hint={profile.extraction.enabled ? `Буде заповнено ${aiCount} ${aiCount === 1 ? 'поле' : 'полів'} ШІ.` : 'Вимкнено: таблиця міститиме лише дані з реєстру для рішень, що пройшли фільтри.'}
        />
      </Card>

      <Card title={`Колонки (${enabledCount} увімкнено)`}>
        <div className="col-list">
          {cols.map((c, i) => {
            const k = key(c);
            const isAi = c.kind === 'ai';
            const disabledAi = isAi && !profile.extraction.enabled;
            return (
              <div key={k} className={`col-row ${c.enabled ? '' : 'off'} ${disabledAi ? 'muted' : ''}`}>
                <div className="col-main">
                  <input type="checkbox" checked={c.enabled} onChange={(e) => patch(i, { ...c, enabled: e.target.checked })} title="Включити в таблицю" />
                  <span className={`badge ${isAi ? 'ai' : 'meta'}`}>{isAi ? 'ШІ' : 'з реєстру'}</span>
                  <div className="col-text">
                    <span className="col-title">{c.kind === 'meta' ? META_COLUMNS[c.id].title : c.field.title || 'Без назви'}</span>
                    <span className="hint">{c.kind === 'meta' ? META_COLUMNS[c.id].hint : `${TYPES[c.field.type]} · ${c.field.instruction || 'інструкцію не задано'}`}</span>
                  </div>
                  <div className="col-actions">
                    <button className="icon-btn" title="Вище" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button className="icon-btn" title="Нижче" disabled={i === cols.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    {c.kind === 'ai' && (
                      <>
                        <button className={`icon-btn ${open === k ? 'on' : ''}`} title="Редагувати" onClick={() => setOpen(open === k ? null : k)}>
                          ✎
                        </button>
                        <button
                          className="icon-btn danger"
                          title="Видалити поле"
                          onClick={async () => {
                            const ok = await confirm({ title: 'Видалити поле?', message: `Колонку «${c.field.title}» буде прибрано з таблиці та інструкцій для ШІ.`, okText: 'Видалити', danger: true });
                            if (ok) setCols(cols.filter((x) => !(x.kind === 'ai' && x.field.id === c.field.id)));
                          }}
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {c.kind === 'ai' && open === k && <AiFieldEditor field={c.field} onChange={(field) => patch(i, { ...c, field })} />}
              </div>
            );
          })}
        </div>
      </Card>

      {profile.extraction.enabled && (
        <Card title="Загальні вказівки для ШІ" hint="Застосовуються до всіх полів ШІ.">
          <div className="form-grid">
            <Field label="Роль аналітика" wide>
              <input value={profile.extraction.role} onChange={(e) => setExtraction({ role: e.target.value })} />
            </Field>
            <Field label="Додаткові вказівки" wide>
              <textarea rows={4} value={profile.extraction.instructions} onChange={(e) => setExtraction({ instructions: e.target.value })} />
            </Field>
            <Field label="Що писати, якщо даних немає">
              <input value={profile.extraction.unknownValue} onChange={(e) => setExtraction({ unknownValue: e.target.value })} />
            </Field>
          </div>
          <details className="prompt-preview">
            <summary>Показати повний текст інструкції для ШІ</summary>
            <pre>{buildExtractionPrompt(profile, enabledAiFields(profile))}</pre>
          </details>
        </Card>
      )}

      <div className="page-foot">
        <button className="btn" onClick={() => setPage('filters')}>
          ← Фільтри
        </button>
        <button className="btn primary" onClick={() => setPage('run')}>
          Далі: запуск →
        </button>
      </div>
    </>
  );
}
