// Інтерфейс між сторінками і двигуном. Реалізація — appApi.ts (у програмі) або mock.ts (перегляд у браузері).
import type {
  AppSettings,
  CatalogView,
  IdsParseResult,
  ModelInfo,
  Profile,
  ProviderId,
  PublicSettings,
  RunEvent,
  RunInfo,
  RunRequest,
  SavedRun,
} from '../shared/types';

export interface InitData {
  settings: PublicSettings;
  profiles: Profile[];
  templates: Profile[];
  models: Partial<Record<ProviderId, ModelInfo[]>>;
  dataDir: string;
  version: string;
  running: boolean;
}

export interface CatalogProgress {
  year: number;
  done: number;
  total: number;
  finished?: boolean;
  /** Автоматичне щотижневе оновлення (не запущене користувачем). */
  background?: boolean;
}

export interface Api {
  init(): Promise<InitData>;
  updateSettings(patch: Partial<AppSettings>): Promise<PublicSettings>;
  setApiKey(provider: ProviderId, key: string | null): Promise<PublicSettings>;
  /** Список моделей провайдера (з кешу; refresh — запитати в API заново). */
  listModels(provider: ProviderId, refresh?: boolean): Promise<ModelInfo[]>;
  saveProfiles(profiles: Profile[]): Promise<void>;
  exportProfile(profile: Profile): Promise<boolean>;
  importProfile(): Promise<Profile | null>;
  pickIdsFile(): Promise<IdsParseResult | null>;
  parseIdsFiles(paths: string[]): Promise<IdsParseResult>;
  onFileDrop(cb: (paths: string[]) => void): () => void;
  getCatalog(refresh?: boolean): Promise<CatalogView>;
  addCatalogUrl(input: string, year?: number): Promise<CatalogView>;
  addCatalogFile(year?: number): Promise<CatalogView>;
  removeCatalogSource(id: string): Promise<CatalogView>;
  deleteYearCache(year: number): Promise<CatalogView>;
  downloadYear(year: number): Promise<CatalogView>;
  cancelDownload(): Promise<void>;
  clearTexts(): Promise<CatalogView>;
  startRun(req: RunRequest): Promise<string>;
  stopRun(): Promise<void>;
  listRuns(): Promise<RunInfo[]>;
  loadRun(id: string): Promise<SavedRun | undefined>;
  deleteRun(id: string): Promise<void>;
  exportRun(id: string): Promise<string | null>;
  getText(docId: string): Promise<string>;
  openPath(p: string): Promise<void>;
  showItem(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onRunEvent(cb: (e: RunEvent) => void): () => void;
  onCatalogProgress(cb: (p: CatalogProgress) => void): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export const api = (): Api => window.api;

/** Прибирає технічні префікси з тексту помилки. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error|AiFatalError):\s*/, '');
}
