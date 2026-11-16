/**
 * Text-only completion on the same providers, settings and HTTP code as the healer (no image is ever sent here).
 * Used by the compile-time suggester; it lives next to the healer so both resolve `DAEMONIZE_MODEL_*` the same way.
 */
import { OPENAI_DEFAULT_URL } from './openai.js';
import { ANTHROPIC_DEFAULT_URL } from './anthropic.js';
import { resolveProviderSettings, type ResolveOptions } from './index.js';
import { postJson, type ProviderConfig } from './shared.js';

export interface TextCompleter {
  complete(request: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export type TextModelResolution =
  | { available: true; completer: TextCompleter; provider: string; model: string; apiKey?: string }
  | { available: false; reason: string };

/** The text completer for `DAEMONIZE_MODEL_*`. Never throws and never touches the network. */
export function resolveTextModel(env: NodeJS.ProcessEnv = process.env, options: ResolveOptions = {}): TextModelResolution {
  const resolved = resolveProviderSettings(env);
  if (!resolved.ok) return { available: false, reason: resolved.reason };
  const { provider, model, baseUrl, apiKey } = resolved.settings;
  const config: ProviderConfig = { model, apiKey, baseUrl, fetch: options.fetch, sleep: options.sleep };
  return { available: true, provider, model, apiKey, completer: createTextCompleter(provider, config) };
}

export function createTextCompleter(provider: string, config: ProviderConfig): TextCompleter {
  if (provider === 'anthropic') {
    const base = (config.baseUrl ?? ANTHROPIC_DEFAULT_URL).replace(/\/+$/, '');
    return {
      async complete({ system, user, maxTokens }) {
        const response = (await postJson(
          `${base}/v1/messages`,
          { 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
          { model: config.model, max_tokens: maxTokens ?? 2000, temperature: 0, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] },
          config,
        )) as { content?: Array<{ type?: string; text?: string }> };
        return (response.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      },
    };
  }
  const base = (config.baseUrl ?? OPENAI_DEFAULT_URL).replace(/\/+$/, '');
  return {
    async complete({ system, user, maxTokens }) {
      const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
      const response = (await postJson(
        `${base}/chat/completions`,
        headers,
        {
          model: config.model,
          temperature: 0,
          max_tokens: maxTokens ?? 2000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        config,
      )) as { choices?: Array<{ message?: { content?: unknown } }> };
      const raw = response.choices?.[0]?.message?.content;
      return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text ?? '').join('\n') : '';
    },
  };
}
