import type { HealRequest, HealResult, Healer } from '../healer.js';
import { SYSTEM_PROMPT, buildPromptText, parseHealAnswer, postJson, promptImages, type ProviderConfig } from './shared.js';

export const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com';

export function createAnthropicHealer(config: ProviderConfig): Healer {
  const base = (config.baseUrl ?? ANTHROPIC_DEFAULT_URL).replace(/\/+$/, '');
  return {
    async locate(req: HealRequest): Promise<HealResult> {
      const content: unknown[] = promptImages(req).map((png) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
      }));
      content.push({ type: 'text', text: buildPromptText(req) });
      const response = (await postJson(
        `${base}/v1/messages`,
        { 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        { model: config.model, max_tokens: 300, temperature: 0, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] },
        config,
      )) as { content?: Array<{ type?: string; text?: string }> };
      const text = (response.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      return parseHealAnswer(text, req);
    },
  };
}
