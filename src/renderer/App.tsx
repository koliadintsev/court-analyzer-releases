import { useState } from 'react';
import { profileFromTemplate, refreshFromTemplate, templateFor } from '../shared/presets';
import { api } from './api';
import { AiPage } from './pages/AiPage';
import { FieldsPage } from './pages/FieldsPage';
import { FiltersPage } from './pages/FiltersPage';
import { HistoryPage } from './pages/HistoryPage';
import { InputPage } from './pages/InputPage';
import { RegistryPage } from './pages/RegistryPage';
import { RunPage } from './pages/RunPage';
import { useApp, type Page } from './state';
import { Menu, PromptModal, plural } from './ui';

function Sidebar() {
  const { page, setPage, ids, profile, run, settings, runs, download } = useApp();
  const dlPct = download?.total ? Math.round((download.done / download.total) * 100) : undefined;
  const aiFields = profile.columns.filter((c) => c.kind === 'ai' && c.enabled).length;
  const done = Object.values(run.records).filter((r) => r.status === 'done').length;
  const steps: { id: Page; n: string; title: string; sub: string }[] = [
    { id: 'input', n: '1', title: 'Перелік рішень', sub: ids.length ? `${ids.length} ${plural(ids.length, 'рішення', 'рішення', 'рішень')}` : 'не додано' },
    { id: 'filters', n: '2', title: 'Фільтри', sub: profile.filters.aiFilterEnabled ? 'з ШІ-фільтром' : 'без ШІ-фільтра' },
    { id: 'fields', n: '3', title: 'Поля таблиці', sub: `${profile.columns.filter((c) => c.enabled).length} колонок, ${aiFields} від ШІ` },
    { id: 'run', n: '4', title: 'Запуск і результати', sub: run.running ? 'виконується…' : done ? `${done} оброблено` : 'готово до запуску' },
  ];
  const missingKey = !settings.keys[settings.ai.extract.provider] && settings.ai.extract.provider !== 'compatible';
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">⚖</div>
        <div>
          <div className="brand-name">CourtAnalyzer</div>
          <div className="brand-sub">аналіз судових рішень</div>
        </div>
      </div>
      <nav>
        {steps.map((s) => (
          <button key={s.id} className={`nav-item ${page === s.id ? 'active' : ''}`} onClick={() => setPage(s.id)}>
            <span className="nav-num">{s.id === 'run' && run.running ? <span className="spinner" /> : s.n}</span>
            <span>
              <span className="nav-title">{s.title}</span>
              <span className="nav-sub">{s.sub}</span>
            </span>
          </button>
        ))}
        {runs.length > 0 && (
          <button className={`nav-item small ${page === 'history' ? 'active' : ''}`} onClick={() => setPage('history')}>
            <span className="nav-num icon">🕘</span>
            <span>
              <span className="nav-title">Історія запусків</span>
              <span className="nav-sub">
                {runs.length} {plural(runs.length, 'запуск', 'запуски', 'запусків')}
              </span>
            </span>
          </button>
        )}
        <div className="nav-sep" />
        <button className={`nav-item small ${page === 'ai' ? 'active' : ''}`} onClick={() => setPage('ai')}>
          <span className="nav-num icon">⚙</span>
          <span>
            <span className="nav-title">Налаштування ШІ</span>
            <span className={`nav-sub ${missingKey ? 'warn' : ''}`}>{missingKey ? 'потрібен API-ключ' : `${settings.ai.extract.model}`}</span>
          </span>
        </button>
        <button className={`nav-item small ${page === 'registry' ? 'active' : ''}`} onClick={() => setPage('registry')}>
          <span className="nav-num icon">{download ? <span className="spinner" /> : '🗄'}</span>
          <span>
            <span className="nav-title">Дані реєстру</span>
            <span className="nav-sub">{download ? `оновлення архіву ${download.year}${dlPct !== undefined ? `: ${dlPct}%` : '…'}` : 'архіви відкритих даних'}</span>
          </span>
        </button>
      </nav>
      <div className="sidebar-foot">версія {useApp().init.version}</div>
    </aside>
  );
}

function ProfileBar() {
  const { profiles, profile, selectProfile, updateProfile, addProfile, deleteProfile, newProfileFromTemplate, init, guard, run, confirm } = useApp();
  const [dialog, setDialog] = useState<null | { kind: 'rename' } | { kind: 'new'; tplId: string } | { kind: 'copy' }>(null);
  const tpl = templateFor(profile);
  return (
    <div className="topbar">
      <span className="topbar-label">Профіль аналізу:</span>
      <select className="profile-select" value={profile.id} disabled={run.running} onChange={(e) => selectProfile(e.target.value)}>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Menu
        label="Дії з профілем"
        items={[
          ...init.templates.map((t) => ({ label: `Новий профіль: «${t.name}»`, onClick: () => setDialog({ kind: 'new', tplId: t.id }) })),
          'sep',
          { label: 'Створити копію поточного', onClick: () => setDialog({ kind: 'copy' }) },
          { label: 'Перейменувати', onClick: () => setDialog({ kind: 'rename' }) },
          ...(tpl
            ? [
                {
                  label: `Оновити з шаблону «${tpl.name}»`,
                  onClick: async () => {
                    const ok = await confirm({
                      title: 'Оновити профіль з шаблону?',
                      message: `Фільтри, поля таблиці та інструкції для ШІ профілю «${profile.name}» буде замінено актуальною версією шаблону. Назва профілю збережеться; ваші зміни в профілі буде втрачено.`,
                      okText: 'Оновити',
                    });
                    if (ok) updateProfile(refreshFromTemplate(profile, tpl));
                  },
                },
              ]
            : []),
          'sep',
          { label: 'Експортувати у файл…', onClick: () => void guard(() => api().exportProfile(profile)) },
          {
            label: 'Імпортувати з файлу…',
            onClick: () =>
              void guard(async () => {
                const p = await api().importProfile();
                if (p) addProfile(p);
              }),
          },
          'sep',
          {
            label: 'Видалити профіль',
            danger: true,
            disabled: profiles.length < 2,
            onClick: async () => {
              const ok = await confirm({ title: 'Видалити профіль?', message: `Профіль «${profile.name}» буде видалено. Цю дію не можна скасувати.`, okText: 'Видалити', danger: true });
              if (ok) deleteProfile(profile.id);
            },
          },
        ]}
      />
      <span className="topbar-hint">Фільтри, поля таблиці та інструкції для ШІ зберігаються в профілі автоматично</span>
      {dialog?.kind === 'rename' && (
        <PromptModal title="Перейменувати профіль" label="Назва профілю" initial={profile.name} okText="Зберегти" onOk={(name) => updateProfile({ ...profile, name })} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'copy' && (
        <PromptModal
          title="Копія профілю"
          label="Назва нового профілю"
          initial={`${profile.name} (копія)`}
          okText="Створити"
          onOk={(name) => addProfile({ ...profileFromTemplate(profile, name), templateId: profile.templateId })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'new' && (
        <PromptModal
          title="Новий профіль"
          label="Назва профілю"
          initial={init.templates.find((t) => t.id === dialog.tplId)?.name ?? 'Новий профіль'}
          okText="Створити"
          onOk={(name) => newProfileFromTemplate(dialog.tplId, name)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

export function App() {
  const { page } = useApp();
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <ProfileBar />
        <div className="content">
          {page === 'input' && <InputPage />}
          {page === 'filters' && <FiltersPage />}
          {page === 'fields' && <FieldsPage />}
          {page === 'run' && <RunPage />}
          {page === 'history' && <HistoryPage />}
          {page === 'ai' && <AiPage />}
          {page === 'registry' && <RegistryPage />}
        </div>
      </main>
    </div>
  );
}
