---
name: daemonize-builder
description: Use when the user needs a Kiro tool for software with no API, such as a web admin page or a terminal program. Guides building it with Daemonize by watching the user do the task once.
---

# Daemonize builder

## When to use

Use Daemonize when the user wants to automate a task in software that has no API and no Kiro server of its own: a web admin page, an internal web tool, or a terminal program. The user does the task once while Daemonize watches. Daemonize then builds a tool that repeats it.

Do not use Daemonize when the application has an API or an existing Kiro server. Use that instead, because it is simpler and more reliable.

## Steps

Follow the steps in this order. Each tool returns plain results that you can read back to the user.

1. Understand the goal. Ask what the user wants done and what they expect back. Call `list_actions` to see what already exists, and `get_action` to look at one in detail.
2. Confirm the application and the address with the user before you start.
3. Call `start_recording` to open the browser window. The user does the clicks. The result says that the recording has started.
4. Call `get_recording_status` to see how many steps were seen so far. Call `finish_recording` when the user says they are done. The result is the new action with its variables.
5. Review the variables (name, type, optional) with the user. Call `update_action` to fix one, after the user agrees.
6. Call `compile` to build the tool. The result says the tool is ready, or lists what is missing.
7. Call `test_action` to run it once in the Playground with example values. The result shows what came back and whether the page changed since the recording.
8. Call `preview_kiro_install` to show what will be added to Kiro. After the user says yes, call `install_to_kiro`. The result says where the tool was added.
9. Call `list_credentials` to see which credentials are still missing. Tell the user to enter them in the Credentials screen.
10. Call `get_activity` when the user asks what ran and what happened. Call `delete_action` only when the user asks to remove an action.

## Safety rules

- A call that changes something (`compile`, `test_action`, `preview_kiro_install`, `install_to_kiro`, `update_action`, `delete_action`) needs the user's explicit word in the chat first. After that, a human approval in Daemonize Studio follows. Tell the user so. You can never approve your own actions.
- Secrets go through the Credentials screen only. Never read, ask for, repeat or store a secret value. Never put a secret in a tool argument.
- If a result has `drifted: true`, the page has changed since it was recorded. Tell the user before you use the result.
- You cannot write files or run commands, and you must not suggest a way around that.

## Troubleshooting

- `missing_secret`: a credential has no value. Ask the user to open the Credentials screen in Daemonize Studio and enter it, then try again.
- `drifted`: the page looks different from when it was shown to Daemonize. Report it to the user. They may need to show the task again with a new recording.
- `approval_denied`: the user refused. Stop, and ask what they want to do instead.
- `approval_timeout`: nobody answered in time. Ask the user to watch Daemonize Studio, then ask again if they still want it.
- `approval_unavailable`: Daemonize Studio is not open, so nobody can approve. Ask the user to open it, then try again.
- `storage_state_missing`: the saved sign-in for the site is missing. Ask the user to sign in again from the Credentials screen.
- A time-out from Kiro on a long call such as `compile`: the work may still be running. Call the tool again.