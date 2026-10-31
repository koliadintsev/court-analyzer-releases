// Налаштування, API-ключі (зашифровані засобами ОС), профілі аналізу та кеш списків моделей.
import { DEFAULT_SETTINGS, LEGACY_TEMPLATE_HASHES, TEMPLATES, profileContentHash, profileFromTemplate, refreshFromTemplate, templateFor } from '../shared/presets';
import type { AppSettings, ModelInfo, Profile, ProviderId, PublicSettings } from '../shared/types';
import type { DataDir } from './storage';

type StoredKey = { value: string; encrypted: boolean };
type ModelCache = Partial<Record<ProviderId, { at: string; models: ModelInfo[] }>>;
const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'compatible'];

const LEGACY_NAMES: Record<string, string> = { 'tpl-generic': 'Загальний аналіз рішень' };

/**
 * Оновлює профілі, які користувач не змінював, до актуальних шаблонів і один раз
 * додає профілі з нових шаблонів (зокрема базовий профіль).
 */
export function upgradeProfiles(list: Profile[], alreadySeeded: string[]): { profiles: Profile[]; changed: boolean; seeded: string[] } {
  let changed = false;
  const profiles = list.map((p) => {
    const tpl = templateFor(p);
    const legacy = p.templateId ? LEGACY_TEMPLATE_HASHES[p.templateId] : undefined;
    if (!tpl || !legacy?.includes(profileContentHash(p))) return p;
    changed = true;
    return refreshFromTemplate(p, tpl, p.name === LEGACY_NAMES[p.templateId!] ? tpl.name : p.name);
  });
  const seeded = new Set(alreadySeeded);
  for (const tpl of TEMPLATES) {
    if (seeded.has(tpl.id)) continue;
    seeded.add(tpl.id);
    if (!profiles.some((p) => templateFor(p)?.id === tpl.id)) {
      profiles.push(profileFromTemplate(tpl));
      changed = true;
    }
  }
  return { profiles, changed, seeded: [...seeded] };
}

export class SettingsStore {
  private constructor(
    private dir: DataDir,
    private settings: AppSettings,
    private stored: Partial<Record<ProviderId, StoredKey>>,
    private keys: Partial<Record<ProviderId, string>>,
    private profiles: Profile[],
    private models: ModelCache,
  ) {}

  static async create(dir: DataDir): Promise<SettingsStore> {
    const saved = await dir.readJson<Partial<AppSettings>>('settings.json', {});
    const settings: AppSettings = { ...DEFAULT_SETTINGS, ...saved, ai: { ...DEFAULT_SETTINGS.ai, ...(saved.ai ?? {}) } };
    const stored = await dir.readJson<Partial<Record<ProviderId, StoredKey>>>('keys.json', {});
    // Ключі розшифровуємо одразу; ті, що не розшифровуються (інший користувач Windows
    // або старий формат), вважаємо відсутніми — їх треба ввести знову.
    const keys: Partial<Record<ProviderId, string>> = {};
    for (const p of PROVIDERS) {
      const k = stored[p];
      if (!k?.value) continue;
      try {
        keys[p] = k.encrypted ? await dir.platform.unprotect(k.value) : k.value;
      } catch {
        delete stored[p];
      }
    }
    const { profiles, changed, seeded } = upgradeProfiles(await dir.readJson<Profile[]>('profiles.json', []), settings.seededTemplates ?? []);
    if (changed) await dir.writeJson('profiles.json', profiles);
    const store = new SettingsStore(dir, settings, stored, keys, profiles, await dir.readJson<ModelCache>('models.json', {}));
    const activeOk = profiles.some((p) => p.id === settings.activeProfileId);
    if (!activeOk || seeded.length !== (settings.seededTemplates ?? []).length) {
      await store.update({ seededTemplates: seeded, ...(activeOk ? {} : { activeProfileId: profiles[0].id }) });
    }
    return store;
  }

  get(): AppSettings {
    return this.settings;
  }

  public(): PublicSettings {
    const keys = Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(this.keys[p])])) as Record<ProviderId, boolean>;
    return { ...this.settings, keys, keysEncrypted: this.dir.platform.encryption };
  }

  async update(patch: Partial<AppSettings>): Promise<PublicSettings> {
    this.settings = { ...this.settings, ...patch, ai: { ...this.settings.ai, ...(patch.ai ?? {}) } };
    await this.dir.writeJson('settings.json', this.settings);
    return this.public();
  }

  async setKey(provider: ProviderId, key: string | null): Promise<PublicSettings> {
    const value = key?.trim();
    if (!value) {
      delete this.stored[provider];
      delete this.keys[provider];
      delete this.models[provider];
      await this.dir.writeJson('models.json', this.models);
    } else {
      const encrypted = this.dir.platform.encryption;
      this.stored[provider] = { value: encrypted ? await this.dir.platform.protect(value) : value, encrypted };
      this.keys[provider] = value;
    }
    await this.dir.writeJson('keys.json', this.stored);
    return this.public();
  }

  getKey(provider: ProviderId): string | undefined {
    return this.keys[provider];
  }

  getProfiles(): Profile[] {
    return this.profiles;
  }

  async saveProfiles(profiles: Profile[]): Promise<void> {
    this.profiles = profiles;
    await this.dir.writeJson('profiles.json', profiles);
  }

  /** Збережені списки моделей провайдерів. */
  modelLists(): Partial<Record<ProviderId, ModelInfo[]>> {
    return Object.fromEntries(Object.entries(this.models).map(([p, v]) => [p, v!.models]));
  }

  modelsAge(provider: ProviderId): number {
    const at = this.models[provider]?.at;
    return at ? Date.now() - Date.parse(at) : Infinity;
  }

  async setModels(provider: ProviderId, models: ModelInfo[]): Promise<void> {
    this.models[provider] = { at: new Date().toISOString(), models };
    await this.dir.writeJson('models.json', this.models);
  }
}
