export interface ParserCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CacheEntry {
  value: string;
  expiresAt: number | null;
}

export class InMemoryParserCache implements ParserCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }
  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now().getTime()) {
      this.store.delete(key);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds === undefined
      ? null
      : this.now().getTime() + ttlSeconds * 1000;
    this.store.set(key, { value: JSON.stringify(value), expiresAt });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
