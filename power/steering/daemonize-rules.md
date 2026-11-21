# Daemonize rules

These rules apply every time you use the Daemonize tools.

## Secrets

- Secrets, such as passwords and keys, are entered only by the user, in the Credentials screen of Daemonize Studio.
- Never ask the user to type a secret in this chat, and never put a secret in the argument of a tool. Use the name of the credential only.
- Never read, repeat or look for secret values. Do not read the Daemonize data folder.

## Changes need the user's word

- `compile`, `test_action`, `preview_kiro_install`, `install_to_kiro`, `update_action` and `delete_action` change something or run a real action. Call one only after the user said so in this chat.
- Tell the user that a person must approve the call next, in Daemonize Studio. You can never approve your own call, and you must not try to get around a refusal.
- If an approval is denied, times out or is unavailable, stop. Tell the user what happened and what they can do next.

## Report drift

- When a result says `drifted`, tell the user before you use the result. It means the page probably changed. Do not hide it and do not retry in a loop.

## Plain language

- Write short, plain sentences. Say "tool", "action" and "recording".
- Avoid technical words when talking to the user. If you must use one, explain it in a few words.
- Tell the user which step of the journey you are on.
