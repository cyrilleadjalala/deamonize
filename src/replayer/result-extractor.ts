import type { ScreenContent, WorkflowResult } from '../types.js';

const MAX_TEXT_LENGTH = 20000;

/**
 * Reduce the final screen of a workflow to the content an agent can use:
 * the page title and the visible text, instead of the raw DOM.
 */
export function extractResult(screen: ScreenContent): WorkflowResult {
  if (screen.type === 'terminal') {
    return { screenType: 'terminal', text: truncate(screen.raw.trimEnd()) };
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(screen.raw);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : undefined;

  const text = screen.raw
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|form|label)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const result: WorkflowResult = {
    screenType: 'dom',
    text: truncate(
      decodeEntities(text)
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n')
    ),
  };
  if (title) {
    result.title = title;
  }
  return result;
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
