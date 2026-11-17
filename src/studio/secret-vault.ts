/** Group G2 owns this file. Stub: an inert vault until the real one lands. */
import type { AppData, SecretVault } from './contracts.js';
import { InertSecretVault } from './inert-services.js';
import type { KeyProvider } from './key-providers.js';

export interface SecretVaultDeps {
  appData: AppData;
  /** Defaults to the OS key provider. */
  keyProvider?: KeyProvider;
  env?: Record<string, string | undefined>;
}

export class NullSecretVault extends InertSecretVault { }

export function createSecretVault(_deps: SecretVaultDeps): SecretVault {
  return new NullSecretVault();
}