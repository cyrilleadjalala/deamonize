/**
 * Commands that open the chat with a named custom agent. No Kiro command id is documented yet, so the list holds the one
 * VS Code candidate; a documented Kiro id is one more line.
 */
export const CHAT_OPEN_COMMANDS: ReadonlyArray<{ id: string; args(agent: string): unknown[] }> = [
  { id: 'workbench.action.chat.open', args: (agent: string): unknown[] => [{ query: `/${agent} ` }] },
];

/** Commands that open the chat without naming an agent, for the button "Open the chat" of the fallback. */
export const CHAT_PLAIN_OPEN_COMMANDS: readonly string[] = ['workbench.action.chat.open', 'workbench.panel.chat.view.copilot.focus'];

/** The first entry of `CHAT_OPEN_COMMANDS` that the host provides, with its arguments for the agent `daemonize`. */
export function chooseChatCommand(available: ReadonlySet<string>): { id: string; args: unknown[] } | undefined {
  for (const entry of CHAT_OPEN_COMMANDS) {
    if (available.has(entry.id)) return { id: entry.id, args: entry.args('daemonize') };
  }
  return undefined;
}

/** The first command that opens the chat as it is, or `undefined` when the host has none. */
export function chooseOpenChatCommand(available: ReadonlySet<string>): string | undefined {
  return CHAT_PLAIN_OPEN_COMMANDS.find((id) => available.has(id));
}
