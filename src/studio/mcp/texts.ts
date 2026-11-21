/** The plain English of the Studio_MCP: titles, descriptions and messages. No path, address, token or stack here. */
import type { StudioMcpToolName } from './tool-names.js';

export const SERVER_NAME = 'daemonize-studio';

export const TOOL_TEXTS: Record<StudioMcpToolName, { title: string; description: string }> = {
  list_actions: {
    title: 'List actions',
    description: 'Shows the actions that were recorded: name, what they need, how risky they are and whether they are compiled into tools.',
  },
  get_action: {
    title: 'Show one action',
    description: 'Shows one action with its steps and the steps that change data. Give the id of the action.',
  },
  list_credentials: {
    title: 'List credentials',
    description: 'Shows the names of the credentials the actions need and whether each one is set. It never shows a value, and nobody gives a value to the assistant.',
  },
  get_activity: {
    title: 'Show recent activity',
    description: 'Shows what tools did lately, newest first. Arguments are already hidden where they are sensitive.',
  },
  start_recording: {
    title: 'Start recording',
    description: 'Opens a browser window where the user records the steps of a new action. The user does the clicks. Give a name and the web address to start from.',
  },
  get_recording_status: {
    title: 'Check the recording',
    description: 'Shows how the recording is going: its state, the number of steps and the first step names.',
  },
  finish_recording: {
    title: 'Finish recording',
    description: 'Ends the recording and saves the action. Use it when the user says they are done.',
  },
  compile: {
    title: 'Build the tools',
    description: 'Turns the recorded actions into tools that can be tested and added to Kiro. It waits up to two minutes.',
  },
  test_action: {
    title: 'Test an action',
    description:
      'Runs one built tool with the given arguments and shows the result. A tool that changes data needs confirm: true and the approval of the user.',
  },
  preview_kiro_install: {
    title: 'Preview adding to Kiro',
    description: 'Shows what adding the tools to Kiro would do, for all projects or for this project. Nothing is written.',
  },
  install_to_kiro: {
    title: 'Add the tools to Kiro',
    description: 'Adds the tools to Kiro after the user approves it. Use the confirmation id from the preview.',
  },
  update_action: {
    title: 'Change an action',
    description: 'Changes the name, the description or the inputs of an action. It needs confirm: true.',
  },
  delete_action: {
    title: 'Delete an action',
    description: 'Deletes one action after the user approves it. It needs confirm: true.',
  },
};

export const MSG = {
  studioNotStarted:
    'The Studio did not start. Ask the user to open the Kiro command list and run "Daemonize: Show log" to see why, then try again.',
  studioUnreachable: 'The Studio did not answer. Try again in a moment.',
  timeout: 'The Studio did not answer in time. Try again in a moment.',
  somethingWentWrong: 'Something went wrong. Try again.',
  unknownTool: 'There is no tool with this name.',
  noAction: 'No action has this id.',
  noToolWithName: 'No tool has this name.',
  openProjectFolder: 'Open the folder of your project in Kiro first.',
  confirmationRequired: 'This changes things, so the user has to confirm. Ask the user, then call again with confirm: true. The user also approves it in Kiro or in the Studio.',
  approvalDenied: 'The user said no, so nothing was changed.',
  approvalTimeout: 'Nobody answered in time, so nothing was changed.',
  approvalUnavailable: 'Daemonize could not ask the user. Ask them to open the Daemonize sidebar in Kiro, then try again.',
  approvalWithdrawn: 'The question was withdrawn, so nothing was changed.',
  credentialInstruction:
    'Ask the user to enter the missing values in the Credentials screen of the Studio or in the Daemonize sidebar of Kiro. Never ask for a value in the chat.',
  secretArgument: 'Credentials are never passed through the assistant. Remove this argument; the user enters it in the Credentials screen.',
  recordingStarted: 'Recording started. The user now does the steps in the browser window that opened.',
  recordingSaving: 'Saving the recording.',
  compileDone: 'The tools are built.',
  compileStillRunning: 'Still building. Look again in a moment.',
  compileFailed: 'The build did not finish.',
  installedReload: 'The tools were added. Kiro has to be reloaded, or the server enabled, before they show up.',
  unknownConfirmation: 'Call preview_kiro_install first and use the confirmation id it gives.',
  truncated: 'The answer was cut because it was too long.',
} as const;

export const RECORDING_STATE_TEXT: Record<string, string> = {
  idle: 'No recording is running.',
  recording: 'Recording. The user is doing the steps in the browser window.',
  saving: 'Saving the recording.',
  compiling: 'Building the tools.',
  done: 'The recording is saved.',
  error: 'The recording did not finish.',
};
