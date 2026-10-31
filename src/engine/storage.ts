// Робоча папка програми: налаштування, кеш архівів, текстів і відповідей ШІ.
import type { Platform } from './platform';

export class DataDir {
  constructor(public readonly platform: Platform) {}

  get root(): string {
    return this.platform.dataDir;
  }

  path(...parts: string[]): string {
    return this.platform.join(this.root, ...parts);
  }

  async readJson<T>(rel: string, fallback: T): Promise<T> {
    const text = await this.platform.readText(this.path(rel));
    if (text === undefined) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    await this.platform.writeText(this.path(rel), JSON.stringify(data, null, 2));
  }

  async exists(rel: string): Promise<boolean> {
    return (await this.platform.stat(this.path(rel))) !== undefined;
  }

  async remove(rel: string): Promise<void> {
    await this.platform.remove(this.path(rel));
  }
}
