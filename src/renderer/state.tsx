// Стан застосунку: налаштування, профілі, перелік рішень, перебіг обробки.
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { newId, profileFromTemplate } from '../shared/presets';
import type { DecisionRecord, Profile, PublicSettings, RunEvent, RunInfo, RunSummary, StageId } from '../shared/types';
import { api, errorMessage, type CatalogProgress, type InitData } from './api';
import { ConfirmModal, type ConfirmOptions } from './ui';

export type Page = 'input' | 'filters' | 'fields' | 'run' | 'history' | 'ai' | 'registry';

export interface StageState {
  label: string;
  done: number;
  total: number;
  detail?: string;
  unit?: 'items' | 'bytes' | 'fraction';
}

export interface RunState {
  running: boolean;
  order: string[];
  records: Record<string, DecisionRecord>;
  stages: Partial<Record<StageId, StageState>>;
  activeStage?: StageId;
  logs: { level: 'info' | 'warn' | 'error'; message: string; time: string }[];
  summary?: RunSummary;
  runId?: string;
  error?: string;
}

type RunAction = { type: 'start'; ids: string[] } | { type: 'event'; event: RunEvent } | { type: 'load'; state: RunState } | { type: 'stopped' };

const emptyRun: RunState = { running: false, order: [], records: {}, stages: {}, logs: [] };

function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start':
      return {
        ...emptyRun,
        running: true,
        order: action.ids,
        records: Object.fromEntries(action.ids.map((id) => [id, { docId: id, status: 'pending' }])),
      };
    case 'load':
      return action.state;
    case 'stopped':
      return { ...state, running: false };
    case 'event': {
      const e = action.event;
      switch (e.type) {
        case 'stage':
          return { ...state, activeStage: e.stage, stages: { ...state.stages, [e.stage]: { label: e.label, done: 0, total: 0 } } };
        case 'progress': {
          const prev = state.stages[e.stage] ?? { label: '', done: 0, total: 0 };
          return { ...state, stages: { ...state.stages, [e.stage]: { ...prev, done: e.done, total: e.total, detail: e.detail ?? prev.detail, unit: e.unit ?? 'items' } } };
        }
        case 'log':
          return { ...state, logs: [...state.logs.slice(-499), { level: e.level, message: e.message, time: e.time }] };
        case 'record':
          return { ...state, records: { ...state.records, [e.record.docId]: e.record } };
        case 'failed':
          return { ...state, error: e.message };
        case 'finished':
          return { ...state, running: false, summary: e.summary, runId: e.runId };
      }
    }
  }
  return state;
}

interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

interface AppContextValue {
  init: InitData;
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  profiles: Profile[];
  profile: Profile;
  updateProfile: (p: Profile) => void;
  selectProfile: (id: string) => void;
  addProfile: (p: Profile) => void;
  deleteProfile: (id: string) => void;
  newProfileFromTemplate: (tplId: string, name: string) => void;
  ids: string[];
  setIds: (ids: string[]) => void;
  page: Page;
  setPage: (p: Page) => void;
  run: RunState;
  startRun: () => Promise<void>;
  loadRun: (id: string) => Promise<void>;
  runs: RunInfo[];
  refreshRuns: () => Promise<void>;
  /** Завантаження архіву, що зараз виконується (зокрема автоматичне оновлення). */
  download: CatalogProgress | null;
  toast: (text: string, kind?: Toast['kind']) => void;
  guard: <T>(fn: () => Promise<T>, okText?: string) => Promise<T | undefined>;
  /** Питає підтвердження у власному вікні й чекає на відповідь. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppContext');
  return v;
}

function loadIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem('ca.ids') ?? '[]');
  } catch {
    return [];
  }
}

function initialPage(): Page {
  const m = /page=(\w+)/.exec(location.hash);
  return (m?.[1] as Page) ?? 'input';
}

export function AppProvider({ init, children }: { init: InitData; children: ReactNode }) {
  const [settings, setSettings] = useState(init.settings);
  const [profiles, setProfiles] = useState(init.profiles);
  const [ids, setIdsState] = useState<string[]>(loadIds);
  const [page, setPage] = useState<Page>(initialPage);
  const [run, dispatch] = useReducer(runReducer, emptyRun);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [download, setDownload] = useState<CatalogProgress | null>(null);
  const [asking, setAsking] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setAsking({ ...opts, resolve })), []);
  const saveTimer = useRef<number>(undefined);
  const refreshRuns = useCallback(async () => setRuns(await api().listRuns()), []);

  const profile = profiles.find((p) => p.id === settings.activeProfileId) ?? profiles[0];

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4500);
  }, []);

  const guard = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (okText) toast(okText, 'ok');
        return r;
      } catch (e) {
        toast(errorMessage(e), 'error');
        return undefined;
      }
    },
    [toast],
  );

  const persistProfiles = useCallback((list: Profile[]) => {
    setProfiles(list);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void api().saveProfiles(list), 400);
  }, []);

  const selectProfile = useCallback(async (id: string) => {
    setSettings(await api().updateSettings({ activeProfileId: id }));
  }, []);

  const value: AppContextValue = {
    init,
    settings,
    setSettings,
    profiles,
    profile,
    updateProfile: (p) => persistProfiles(profiles.map((x) => (x.id === p.id ? p : x))),
    selectProfile: (id) => void selectProfile(id),
    addProfile: (p) => {
      persistProfiles([...profiles, p]);
      void selectProfile(p.id);
    },
    deleteProfile: (id) => {
      const rest = profiles.filter((p) => p.id !== id);
      if (!rest.length) return;
      persistProfiles(rest);
      void selectProfile(rest[0].id);
    },
    newProfileFromTemplate: (tplId, name) => {
      const tpl = init.templates.find((t) => t.id === tplId) ?? init.templates[0];
      const p = { ...profileFromTemplate(tpl, name), id: newId('profile') };
      persistProfiles([...profiles, p]);
      void selectProfile(p.id);
    },
    ids,
    setIds: (list) => {
      setIdsState(list);
      try {
        localStorage.setItem('ca.ids', JSON.stringify(list));
      } catch {
        // сховище недоступне — перелік живе лише до закриття програми
      }
    },
    page,
    setPage,
    run,
    startRun: async () => {
      dispatch({ type: 'start', ids });
      try {
        await api().startRun({ ids, profile });
      } catch (e) {
        toast(errorMessage(e), 'error');
        dispatch({ type: 'event', event: { type: 'failed', message: errorMessage(e) } });
      } finally {
        dispatch({ type: 'stopped' });
        void refreshRuns();
      }
    },
    loadRun: async (id) => {
      const saved = await api().loadRun(id);
      if (!saved) return;
      dispatch({
        type: 'load',
        state: {
          ...emptyRun,
          order: saved.records.map((r) => r.docId),
          records: Object.fromEntries(saved.records.map((r) => [r.docId, r])),
          summary: saved.summary,
          runId: saved.id,
          error: saved.error,
        },
      });
    },
    runs,
    refreshRuns,
    download,
    toast,
    guard,
    confirm,
  };

  useEffect(() => api().onRunEvent((e) => dispatch({ type: 'event', event: e })), []);
  useEffect(() => api().onCatalogProgress((p) => setDownload(p.finished ? null : p)), []);
  useEffect(() => void refreshRuns(), [refreshRuns]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {asking && (
        <ConfirmModal
          {...asking}
          onClose={(ok) => {
            asking.resolve(ok);
            setAsking(null);
          }}
        />
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
