import type { Healer } from '../healer.js';
import { createChatCompletionsHealer } from './openai-compatible.js';
import type { ProviderConfig } from './shared.js';

export const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';

export function createOpenAIHealer(config: ProviderConfig): Healer {
  return createChatCompletionsHealer({ ...config, baseUrl: config.baseUrl ?? OPENAI_DEFAULT_URL });
}
