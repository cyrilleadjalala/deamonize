import type { HealRequest, HealResult, Healer } from '../healer.js';
import { SYSTEM_PROMPT, buildPromptText, parseHealAnswer, postJson, promptImages, type ProviderConfig } from './shared.js';

/** Chat-completions client for OpenAI and for servers that speak the same protocol (Ollama, vLLM). */
export function createChatCompletionsHealer(config: ProviderConfig & { baseUrl: string }): Healer {
  const base = config.baseUrl.replace(/\/+$/, '');
  return {
    async locate(req: HealRequest): Promise<HealResult> {
      const content: unknown[] = [{ type: 'text', text: buildPromptText(req) }];
      for (const png of promptImages(req)) {
        content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } });
      }
      const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
      const response = (await postJson(
        `${base}/chat/completions`,
        headers,
        {
          model: config.model,
          temperature: 0,
          max_tokens: 300,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
          ],
        },
        config,
      )) as { choices?: Array<{ message?: { content?: unknown } }> };
      const raw = response.choices?.[0]?.message?.content;
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text ?? '').join('\n') : '';
      return parseHealAnswer(text, req);
    },
  };
}

export function createOpenAICompatibleHealer(config: ProviderConfig & { baseUrl: string }): Healer {
  return createChatCompletionsHealer(config);
}
