import { describe, expect, it } from 'vitest';
import { CHAT_OPEN_COMMANDS, chooseChatCommand, chooseOpenChatCommand } from '../../../kiro-extension/src/core/chat-launch';

describe('chooseChatCommand', () => {
  it('picks the chat command with the agent daemonize when the host has it', () => {
    expect(chooseChatCommand(new Set(['x', CHAT_OPEN_COMMANDS[0].id]))).toEqual({
      id: 'workbench.action.chat.open',
      args: [{ query: '/daemonize ' }],
    });
  });

  it('answers undefined when the host has none of the commands', () => {
    expect(chooseChatCommand(new Set(['workbench.action.files.openFolder']))).toBeUndefined();
    expect(chooseChatCommand(new Set())).toBeUndefined();
  });

  it('chooses the first listed command when several are available', () => {
    const all = new Set(CHAT_OPEN_COMMANDS.map((c) => c.id));
    expect(chooseChatCommand(all)?.id).toBe(CHAT_OPEN_COMMANDS[0].id);
  });
});

describe('chooseOpenChatCommand', () => {
  it('finds a command that opens the chat, or none', () => {
    expect(chooseOpenChatCommand(new Set(['workbench.panel.chat.view.copilot.focus']))).toBe('workbench.panel.chat.view.copilot.focus');
    expect(chooseOpenChatCommand(new Set(['other']))).toBeUndefined();
  });
});
