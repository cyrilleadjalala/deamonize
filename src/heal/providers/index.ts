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

/**
 * Build the model healer from `DAEMONIZE_MODEL_*`. Never throws and never touches the network:
 * a missing setting is reported as `available: false` with the reason.
 */
export function resolveHealer(env: NodeJS.ProcessEnv = process.env, options: ResolveOptions = {}): HealerResolution {
  const provider = env.DAEMONIZE_MODEL_PROVIDER?.trim().toLowerCase();
  if (!provider) return { available: false, reason: 'DAEMONIZE_MODEL_PROVIDER is not set' };
  if (!PROVIDERS.includes(provider)) {
    return { available: false, reason: `DAEMONIZE_MODEL_PROVIDER must be one of ${PROVIDERS.join(', ')}` };
  }
  const model = env.DAEMONIZE_MODEL_NAME?.trim();
  if (!model) return { available: false, reason: 'DAEMONIZE_MODEL_NAME is not set' };
  const baseUrl = env.DAEMONIZE_MODEL_BASE_URL?.trim() || undefined;
  const fallbackKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : undefined;
  const apiKey = env.DAEMONIZE_MODEL_API_KEY?.trim() || fallbackKey?.trim() || undefined;
  const common = { model, apiKey, fetch: options.fetch, sleep: options.sleep };

  if (provider === 'openai-compatible') {
    // Local servers often need no key, but they need an address
    if (!baseUrl) return { available: false, reason: 'DAEMONIZE_MODEL_BASE_URL is required for openai-compatible' };
    return { available: true, provider, model, healer: createOpenAICompatibleHealer({ ...common, baseUrl }) };
  }
  if (!apiKey) return { available: false, reason: `no API key: set DAEMONIZE_MODEL_API_KEY for ${provider}` };
  const healer = provider === 'anthropic' ? createAnthropicHealer({ ...common, baseUrl }) : createOpenAIHealer({ ...common, baseUrl });
  return { available: true, provider, model, healer };
}
