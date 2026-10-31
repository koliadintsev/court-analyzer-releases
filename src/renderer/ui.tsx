// Дрібні компоненти інтерфейсу.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isoToUa, maskDateTyping, uaToIso } from './dates';

export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, hint, children, actions, className }: { title?: ReactNode; hint?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <p className="hint">{hint}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint block">{hint}</span>}
      </span>
    </label>
  );
}

export function Chips({ options, value, onChange }: { options: Record<string, string>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips">
      {Object.entries(options).map(([code, name]) => {
        const on = value.includes(code);
        return (
          <button type="button" key={code} className={`chip ${on ? 'on' : ''}`} onClick={() => onChange(on ? value.filter((v) => v !== code) : [...value, code])}>
            {on ? '✓ ' : ''}
            {name}
          </button>
        );
      })}
    </div>
  );
}

export function Progress({ done, total, indeterminate }: { done: number; total: number; indeterminate?: boolean }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className={`progress ${indeterminate ? 'indeterminate' : ''}`}>
      <div className="progress-bar" style={{ width: indeterminate ? undefined : `${pct}%` }} />
    </div>
  );
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  okText?: string;
  danger?: boolean;
}

/**
 * Вікно підтвердження. Стандартний window.confirm у Tauri асинхронний (повертає Promise,
 * а не відповідь), тому дія виконувалася б до вибору користувача — використовуємо власне.
 */
export function ConfirmModal({ title, message, okText = 'Так', danger, onClose }: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  // Для небезпечних дій фокус на «Скасувати», щоб випадковий Enter нічого не видалив.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => (danger ? cancelRef : okRef).current?.focus(), [danger]);
  return (
    <Modal
      title={title}
      onClose={() => onClose(false)}
      footer={
        <>
          <button ref={cancelRef} className="btn" onClick={() => onClose(false)}>
            Скасувати
          </button>
          <button ref={okRef} className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={() => onClose(true)}>
            {okText}
          </button>
        </>
      }
    >
      {message ? <p className="confirm-text">{message}</p> : null}
    </Modal>
  );
}

/** Діалог введення тексту (вбудований window.prompt у Tauri не підтримується). */
export function PromptModal({ title, label, initial, okText, onOk, onClose }: { title: string; label: string; initial: string; okText: string; onOk: (v: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const submit = () => value.trim() && (onOk(value.trim()), onClose());
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={submit}>
            {okText}
          </button>
        </>
      }
    >
      <Field label={label} wide>
        <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
    </Modal>
  );
}

export function Menu({ label, items }: { label: ReactNode; items: ({ label: string; onClick: () => void; danger?: boolean; disabled?: boolean } | 'sep')[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && (
        <div className="menu-list">
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                className={`menu-item ${it.danger ? 'danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Поле, яке зберігає значення після виходу з поля або Enter (щоб не надсилати кожну літеру). */
export function CommitInput({ value, onCommit, ...rest }: { value: string | number; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  const commit = () => local !== String(value) && onCommit(local);
  return <input {...rest} value={local} onChange={(e) => setLocal(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

/** Поле дати у форматі ДД.ММ.РРРР; значення — 'РРРР-ММ-ДД' або порожній рядок. */
export function DateInput({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const [text, setText] = useState(isoToUa(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(isoToUa(value));
    setBad(false);
  }, [value]);
  const commit = () => {
    if (!text.trim()) {
      setBad(false);
      if (value) onChange('');
      return;
    }
    const iso = uaToIso(text);
    if (!iso) return setBad(true);
    setBad(false);
    if (iso !== value) onChange(iso);
  };
  return (
    <>
      <input
        className={bad ? 'invalid' : ''}
        inputMode="numeric"
        placeholder="дд.мм.рррр"
        value={text}
        onChange={(e) => setText(maskDateTyping(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {bad && <span className="hint error">Такої дати не існує — введіть у форматі дд.мм.рррр</span>}
    </>
  );
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} ГБ`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} МБ`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} КБ`;
  return `${n} Б`;
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
