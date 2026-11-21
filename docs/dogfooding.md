# Dogfooding: using the Studio MCP while building Daemonize

Daemonize gives Kiro an MCP server of its own (`daemonize mcp`, the Studio MCP) and a Daemonize agent that uses it. This page explains how the maintainers use that agent to build a tool on a real application, so that the project is itself a user of Kiro's MCP feature.

The example application is Adminer, a database page, in `examples/adminer`.

Every Studio MCP tool is written below as `daemonize-studio/<tool>`, the way Kiro shows it to the agent.

## Before you start

1. Install the dependencies and build: `npm install`, then `npm run build`.
   Expected: the build ends with no error and `dist/` exists.
2. Start the Adminer example: `cd examples/adminer`, then `docker compose up -d --wait`.
   Expected: Adminer answers on `http://127.0.0.1:8080`.
3. Copy `.kiro/settings/mcp.json.example` to `.kiro/settings/mcp.json`. The copy is ignored by git. The example holds no secret.
   Expected: Kiro lists the server `daemonize-studio` in its MCP settings. Reload the window if it does not.
4. Start Daemonize Studio in another terminal: `daemonize studio`.
   Expected: the terminal prints the address of the Studio. Keep it open, because you approve changes there.
5. In Kiro, choose the agent `daemonize`.
   Expected: the agent greets you and asks what you want Daemonize to do.

## Record, compile and test an action

Tell the agent: "Record the task that lists the customers in Adminer, starting at http://127.0.0.1:8080."

1. The agent calls `daemonize-studio/list_actions`.
   Expected: it tells you which actions exist, so it does not build a copy.
2. The agent calls `daemonize-studio/start_recording`.
   Expected: a browser window opens on Adminer.
3. You do the task yourself: log in and open the `customers` table. Type the database password in the browser window only. Never type it in the chat.
   Expected: the agent calls `daemonize-studio/get_recording_status` and reports the steps it sees.
4. You say you are done. The agent calls `daemonize-studio/finish_recording`.
   Expected: the recording is saved as an action. The agent calls `daemonize-studio/get_action` and shows you the variables.
5. You say "build it". The agent calls `daemonize-studio/compile`.
   Expected: Daemonize Studio shows an approval request. You approve it there. The build ends and the agent says the tool is ready.
6. You give example values and say "test it". The agent calls `daemonize-studio/test_action`.
   Expected: Daemonize Studio shows a second approval request. After you approve it, the agent shows the rows that came back. If the result says `drifted`, the agent tells you first.
7. The agent calls `daemonize-studio/list_credentials`.
   Expected: it names the credentials you still have to enter and sends you to the Credentials screen of Daemonize Studio. It never asks for the value.
8. To add the tool to Kiro, the agent calls `daemonize-studio/preview_kiro_install` and shows the plan. After your yes and your approval in the Studio, it calls `daemonize-studio/install_to_kiro`.
   Expected: the new tool appears in Kiro's MCP list.
9. Afterwards, the agent can call `daemonize-studio/get_activity`.
   Expected: the list shows each call above with its decision and outcome.

To stop the example, run `docker compose down -v` in `examples/adminer`.

## What was not done with the agent

These parts were done by hand or by scripts, not by the Daemonize agent:

- The code of Daemonize itself, its tests and its documentation.
- The recorded workflows committed in `examples/adminer/daemonize.workflows.json`. They come from `examples/adminer/record-workflows.mjs`, which drives the recorder with a script.
- Starting and stopping the Adminer stack with Docker.
- Typing the database password. Only a person does that, in the browser window or in the Credentials screen.
- Every approval in Daemonize Studio. The agent cannot approve its own calls.

## Calls recorded during development

This table is empty on purpose. The calls described above have not happened yet. The maintainers will fill it from the Audit Log, which is the Activity view of Daemonize Studio, after they run the steps with the agent. Remove any secret from a row before you add it.

| Date | Tool | Outcome |
| ---- | ---- | ------- |
