---
name: "daemonize-studio"
displayName: "Daemonize"
description: "Build Kiro tools for software that has no API, by recording a task once with Daemonize"
keywords:
  - "daemonize"
  - "studio"
  - "mcp"
  - "recording"
  - "automation"
  - "browser"
  - "agent"
---

# Daemonize

Daemonize builds a Kiro tool for software that has no API, such as a web admin page or a terminal program. You do the task once while Daemonize watches. Daemonize then builds a tool that repeats the task.

This Power gives Kiro the Daemonize Studio tools, a Daemonize agent that guides you through the steps, a skill, and a short set of rules.

## What you need

- The `daemonize` command must be installed and available on your PATH.
- Daemonize Studio keeps your passwords. You type them once in the Credentials screen of the Studio, never in the chat.

## What the Power does

1. You tell the agent which task you want done and where it starts.
2. You do the task once in a browser window that Daemonize opens. Daemonize records it.
3. The agent builds the tool, tests it with example values, and adds it to Kiro after you say yes.

## The Studio tools

Reading and recording (no question asked first):

- `list_actions`: lists the actions you have already recorded.
- `get_action`: shows one action with its variables.
- `list_credentials`: lists the names of the credentials, never their values.
- `get_activity`: shows what the tools did recently.
- `start_recording`: opens the browser so you can do the task.
- `get_recording_status`: shows how the recording is going.
- `finish_recording`: ends the recording.

Changes (a person must approve each call in Daemonize Studio):

- `compile`: builds the tool from the recording.
- `test_action`: runs the action once for real.
- `preview_kiro_install`: shows what would be added to Kiro.
- `install_to_kiro`: adds the tool to Kiro.
- `update_action`: changes the name or a variable of an action.
- `delete_action`: removes an action.

## Safety rules

- Secrets are typed only in the Credentials screen of Daemonize Studio. The agent never asks for them and never reads them.
- Anything that changes something needs your word in the chat first, and then your approval in Daemonize Studio. The agent cannot approve its own calls.
- If a result says `drifted`, the page probably changed. The agent tells you before it uses the result.
- The agent cannot write files or run commands.

## Install

In the Kiro Powers panel, choose "Install from folder" and pick this `power` folder, or choose "Install from repository URL" and give the address of the Daemonize repository. The Daemonize extension for Kiro can also install it with the command "Install the Daemonize Power".

See `steering/daemonize-rules.md` for the rules the agent follows and `skills/daemonize-builder/SKILL.md` for the guide.
