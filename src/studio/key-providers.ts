/** Group G2 owns this file. Stub: types only. */
export class KeyStoreUnavailableError extends Error { }

export interface KeyProvider {
  readonly id: string;
  /** undefined when the store works and has no key yet. Throws KeyStoreUnavailableError on any other failure. */
  get(): Promise<Buffer | undefined>;
  /** Throws KeyStoreUnavailableError. */
  create(key: Buffer): Promise<void>;
}

/** Stub: a provider that is never available. */
export function createKeyProvider(_options: { dataDir?: string; env?: Record<string, string | undefined> } = {}): KeyProvider {
  return {
    id: 'unavailable',
    get: async () => {
      throw new KeyStoreUnavailableError('not implemented');
    },
    create: async () => {
      throw new KeyStoreUnavailableError('not implemented');
    },
  };
}