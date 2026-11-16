import type { Healer } from '../healer.js';
import { createAnthropicHealer } from './anthropic.js';
import { createOpenAIHealer } from './openai.js';
import { createOpenAICompatibleHealer } from './openai-compatible.js';

export type HealerResolution =
  | { available: true; healer: Healer; provider: string; model: string }
  | { available: false; reason: string };

export interface ResolveOptions {
  /** Test seam for the HTTP call. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const PROVIDERS = ['anthropic', 'openai', 'openai-compatible'];

export interface ProviderSettings {
  provider: 'anthropic' | 'openai' | 'openai-compatible';
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Read `DAEMONIZE_MODEL_*`: the one place that decides which provider, model, address and key are used, shared by
 * the healer and by the compile-time suggester. Never throws and never touches the network.
 */
export function resolveProviderSettings(env: NodeJS.ProcessEnv = process.env): { ok: true; settings: ProviderSettings } | { ok: false; reason: string } {
  const provider = env.DAEMONIZE_MODEL_PROVIDER?.trim().toLowerCase();
  if (!provider) return { ok: false, reason: 'DAEMONIZE_MODEL_PROVIDER is not set' };
  if (!PROVIDERS.includes(provider)) {
    return { ok: false, reason: `DAEMONIZE_MODEL_PROVIDER must be one of ${PROVIDERS.join(', ')}` };
  }
  const model = env.DAEMONIZE_MODEL_NAME?.trim();
  if (!model) return { ok: false, reason: 'DAEMONIZE_MODEL_NAME is not set' };
  const baseUrl = env.DAEMONIZE_MODEL_BASE_URL?.trim() || undefined;
  const fallbackKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : undefined;
  const apiKey = env.DAEMONIZE_MODEL_API_KEY?.trim() || fallbackKey?.trim() || undefined;
  if (provider === 'openai-compatible') {
    // Local servers often need no key, but they need an address
    if (!baseUrl) return { ok: false, reason: 'DAEMONIZE_MODEL_BASE_URL is required for openai-compatible' };
  } else if (!apiKey) {
    return { ok: false, reason: `no API key: set DAEMONIZE_MODEL_API_KEY for ${provider}` };
  }
  return { ok: true, settings: { provider: provider as ProviderSettings['provider'], model, baseUrl, apiKey } };
}

/**
 * Build the model healer from `DAEMONIZE_MODEL_*`. Never throws and never touches the network:
 * a missing setting is reported as `available: false` with the reason.
 */
export function resolveHealer(env: NodeJS.ProcessEnv = process.env, options: ResolveOptions = {}): HealerResolution {
  const resolved = resolveProviderSettings(env);
  if (!resolved.ok) return { available: false, reason: resolved.reason };
  const { provider, model, baseUrl, apiKey } = resolved.settings;
  const common = { model, apiKey, fetch: options.fetch, sleep: options.sleep };
  if (provider === 'openai-compatible') {
    return { available: true, provider, model, healer: createOpenAICompatibleHealer({ ...common, baseUrl: baseUrl as string }) };
  }
  const healer = provider === 'anthropic' ? createAnthropicHealer({ ...common, baseUrl }) : createOpenAIHealer({ ...common, baseUrl });
  return { available: true, provider, model, healer };
}