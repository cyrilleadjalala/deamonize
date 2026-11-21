/**
 * Commands that open the chat with a named custom agent. No Kiro command id is documented yet, so the list holds the one
 * VS Code candidate; a documented Kiro id is one more line. G0 seam: the data is final, `chooseChatCommand` belongs to group G-E1.
 */
export const CHAT_OPEN_COMMANDS: ReadonlyArray<{ id: string; args(agent: string): unknown[] }> = [
  { id: 'workbench.action.chat.open', args: (agent: string): unknown[] => [{ query: `/${agent} ` }] },
];

/** The first entry of `CHAT_OPEN_COMMANDS` that the host provides, with its arguments for the agent `daemonize`. */
export function chooseChatCommand(_available: ReadonlySet<string>): { id: string; args: unknown[] } | undefined {
  throw new Error('not implemented: G-E1');
}
