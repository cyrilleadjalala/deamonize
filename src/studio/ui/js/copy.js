// @ts-check
/**
 * Every text of the main-path screens of the first flow (welcome, new action, recording status, credentials, test,
 * connect), in plain language. A unit test lints this file against the Plain_Language list, so a new text goes here
 * and not into a view. The only technical texts are `copyMcp` and `copyMcpDone` (the explicit technical option).
 * File paths and secret names are shown by the views in `code` elements and are not part of this file.
 */

export const COPY = {
  // ----- welcome and the new-action form -----------------------------------------------------------------------
  welcomeTitle: 'Welcome to Daemonize',
  welcomeLead: 'Teach Daemonize a task once by doing it in a browser window. It turns what you did into a tool that an AI assistant can use.',
  welcomeStep1: 'Describe the task and open the web page where it starts.',
  welcomeStep2: 'Do the task once in the browser window that opens.',
  welcomeStep3: 'Add your credentials, try the tool, and connect it to Kiro.',
  newAction: '+ New action',
  newActionTitle: 'New action',
  nameLabel: 'What should this action be called?',
  nameHelp: 'For example: Search customers. Use 1 to 80 characters with at least one letter or number.',
  urlLabel: 'Web address where the task starts',
  urlHelp: 'For example: https://example.com/login',
  reuseLabel: 'Reuse my signed-in session',
  hintNoSession: 'No saved session yet. Recording with this box checked will save one.',
  hintSession: 'A signed-in session is saved for this site. Check the box to use it and skip the sign-in.',
  hintChecking: 'Looking for a saved session\u2026',
  startRecording: 'Start recording',
  cancel: 'Cancel',
  starting: 'Starting\u2026',
  startFailed: 'The recording could not be started. Check the message, then try again.',
  unreachable: 'The Studio cannot be reached. Make sure it is still running, then try again.',
  recordingInProgress: 'A recording is in progress.',
  seeRecording: 'See it',

  // ----- recording status ---------------------------------------------------------------------------------------
  recordTitle: 'Recording',
  recordLead: 'Do the task in the browser window. Come back here when you are done.',
  stateLabel: 'State',
  stepsLabel: 'Steps so far',
  lastStepsLabel: 'Latest steps',
  noSteps: 'No steps yet.',
  stop: 'Finish and save',
  stopping: 'Saving\u2026',
  stopFailed: 'The recording could not be stopped. Try again.',
  connectionLost: 'Connection lost. Trying again.',
  nothingRunning: 'Nothing is being recorded right now.',
  backToOverview: 'Back to the overview',
  testIt: 'Test it',
  addCredentials: 'Add your credentials',
  errorTitle: 'The recording stopped',
  recoveryFile: 'Your steps were kept in this file:',
  tryAgain: 'Start again from the overview',
  doneLead: 'Your tool is ready. Try it, then connect it to Kiro.',

  // ----- state words and announcements -------------------------------------------------------------------------
  stateIdle: 'Ready',
  stateRecording: 'Recording',
  stateSaving: 'Saving',
  stateCompiling: 'Building your tool',
  stateDone: 'Done',
  stateError: 'Stopped with a problem',
  saidIdle: 'Ready.',
  saidRecording: 'Recording started. Do the steps in the browser window.',
  saidSaving: 'Saving what you did.',
  saidCompiling: 'Building your tool.',
  saidDone: 'Your tool is ready.',
  saidError: 'Something went wrong. Read the message on this page.',
  buildRunningGenerating: 'Building your tool',
  buildRunningInstalling: 'Installing what your tool needs',
  buildDone: 'Your tool is built',
  buildError: 'Building your tool failed',
  buildIdle: 'Ready',
  saidBuildGenerating: 'Building your tool.',
  saidBuildInstalling: 'Installing what your tool needs.',
  saidBuildDone: 'Your tool is built.',
  saidBuildError: 'Building your tool failed.',
  saidBuildIdle: 'Ready.',

  // ----- rebuild ------------------------------------------------------------------------------------------------
  rebuild: 'Recompile',
  rebuildFailed: 'The tool could not be rebuilt. Try again in a moment.',

  // ----- sessions -----------------------------------------------------------------------------------------------
  sessionYes: 'Saved session available: yes',
  sessionNo: 'Saved session available: no',
  forgetSession: 'Forget session',
  sessionForgotten: 'The saved session was removed.',
  sessionForgetFailed: 'The saved session could not be removed. Try again.',

  // ----- credentials --------------------------------------------------------------------------------------------
  credentialsTitle: 'Credentials',
  credentialsLead: 'Type each credential once. It is stored encrypted on this computer and is never shown again.',
  credentialsLink: 'Credentials',
  none: 'No credentials needed',
  kindPassword: 'Password',
  kindTotp: 'Authenticator key',
  kindToken: 'Access code',
  configured: 'Configured',
  missing: 'Missing',
  valueFor: 'Value for',
  save: 'Save',
  saving: 'Saving\u2026',
  remove: 'Remove',
  removing: 'Removing\u2026',
  totpHelp:
    'The key appears next to the QR code when you turn on two-step verification in the application. You can paste the key, or the full text that starts with otpauth://.',
  loadFailed: 'The list of credentials could not be loaded. Check that the Studio is running, then try again.',
  retry: 'Retry',
  reasonInvalid: 'The value is not valid. Check it and try again.',
  reasonNotAllowed: 'This was not allowed. Reload the page and try again.',
  reasonUnavailable: 'Secure storage is not available on this computer, so nothing was saved.',
  reasonNoAnswer: 'The Studio did not answer in time. Try again.',
  reasonOther: 'Something went wrong. Try again.',
  notSaved: 'Not saved.',
  notRemoved: 'Not removed.',
  missingNotice: 'Some credentials are missing, so a call may fail.',
  missingLink: 'Add them on the credentials page',

  // ----- connect ------------------------------------------------------------------------------------------------
  connectTitle: 'Connect your tool',
  connectLead: 'Add this tool to Kiro, or copy its settings for another assistant.',
  folderLabel: 'Folder of your Kiro project',
  folderHelp: 'The full path of the folder that holds your project.',
  connectButton: 'Connect to Kiro',
  checking: 'Checking\u2026',
  dialogTitle: 'Connect to Kiro',
  dialogLead: 'Daemonize will write these files in this folder:',
  outcomeCreate: 'create',
  outcomeMerge: 'merge',
  outcomeReplace: 'replace',
  replaceNotice: 'An entry with the same name already exists in the settings file. It will be replaced.',
  confirm: 'Confirm and connect',
  installing: 'Connecting\u2026',
  close: 'Close',
  connectedTitle: 'Your tool is connected',
  connectedLead: 'These files were written:',
  placeholdersLead: 'These names were added without any value. Each one must be set on the computer where Kiro runs, and Kiro may ask you to approve it in its settings:',
  noPlaceholders: 'This tool needs no credentials.',
  credentialsFromVault: 'This tool will use the passwords you saved in Daemonize. Nothing else to set up.',
  copyMcp: 'Copy MCP configuration',
  copyMcpDone: 'MCP configuration copied',
  copyMcpFailed: 'The settings could not be loaded.',
  powerInstead: 'Add as a Kiro Power instead',
  powerLead: 'Nothing is written for this option. In Kiro, open the Powers panel and import a power from a local folder. Choose this folder:',
  powerSteps1: 'Open the Powers panel in Kiro.',
  powerSteps2: 'Choose to add a power from a local folder.',
  powerSteps3: 'Select the folder shown above and confirm.',
  notBuilt: 'Your tool is not built yet. Build it first, then connect it.',
  previewFailed: 'The connection could not be prepared. Your Kiro files were left as they were. Check the message, then try again.',
  installFailed: 'The connection could not be made. Your Kiro files were left as they were. Try again.',
  scopeLegend: 'Where should Kiro offer this tool?',
  scopeGlobal: 'All my projects',
  scopeProject: 'Only this project',
  scopeGlobalSentence: 'This tool will be available in every Kiro project you open.',
  autoAddLabel: 'Keep Kiro up to date',
  autoAddHelp: 'When this is on, Daemonize updates these Kiro files again after each successful try of your tool. You can turn it off at any time.',
  autoAddNotSaved: 'This choice cannot be remembered on this computer, so it stays off.',
  backupYes: 'A copy of your current Kiro settings file is kept next to it, with the ending .bak.',
  backupNone: 'There is no previous settings file, so no backup is made.',
  connectedReload: 'To see the change, open the panel in Kiro that lists tool servers and reload it, or restart Kiro.',
  missingLead: 'These credentials have no value yet, so a call may fail until you add them:',
  removeButton: 'Remove from Kiro',
  removeLead: 'Already connected to Kiro:',
  removeConfirmLead: 'This tool will be taken out of Kiro in this folder. Your other Kiro tools stay as they are:',
  removeConfirm: 'Yes, remove it',
  removing: 'Removing\u2026',
  removedTitle: 'Your tool was removed from Kiro',
  removedLead: 'These files were changed or deleted:',
  removeFailed: 'The tool could not be removed from Kiro. Your Kiro files were left as they were. Try again.',
  removeNothing: 'Nothing was left to remove.',

  // ----- demo and sample mode ------------------------------------------------------------------------------------
  demoNote: 'This is a demo. Install Daemonize to use this.',
};

export { COPY_SECRETS, allSecretsCopyTexts } from './copy-secrets.js';
/** Texts that are the explicit technical option and are exempt from the plain-language lint. */
export const TECHNICAL_TEXTS = new Set([COPY.copyMcp, COPY.copyMcpDone]);

export const RECORDING_STATES = ['idle', 'recording', 'saving', 'compiling', 'done', 'error'];
export const COMPILE_STATES = ['idle', 'running', 'done', 'error'];
export const COMPILE_PHASES = [null, 'generating', 'installing'];
export const SECRET_KINDS = ['password', 'totp', 'token'];

/**
 * The visible word of a state.
 * @param {'recording' | 'compile'} kind
 * @param {string} state
 * @param {string | null} [phase] only for the compile kind
 */
export function statusText(kind, state, phase = null) {
  if (kind === 'compile') {
    if (state === 'running') return phase === 'installing' ? COPY.buildRunningInstalling : COPY.buildRunningGenerating;
    if (state === 'done') return COPY.buildDone;
    if (state === 'error') return COPY.buildError;
    return COPY.buildIdle;
  }
  switch (state) {
    case 'recording':
      return COPY.stateRecording;
    case 'saving':
      return COPY.stateSaving;
    case 'compiling':
      return COPY.stateCompiling;
    case 'done':
      return COPY.stateDone;
    case 'error':
      return COPY.stateError;
    default:
      return COPY.stateIdle;
  }
}

/**
 * The sentence announced to screen readers when a state changes.
 * @param {'recording' | 'compile'} kind
 * @param {string} state
 * @param {string | null} [phase]
 */
export function announceText(kind, state, phase = null) {
  if (kind === 'compile') {
    if (state === 'running') return phase === 'installing' ? COPY.saidBuildInstalling : COPY.saidBuildGenerating;
    if (state === 'done') return COPY.saidBuildDone;
    if (state === 'error') return COPY.saidBuildError;
    return COPY.saidBuildIdle;
  }
  switch (state) {
    case 'recording':
      return COPY.saidRecording;
    case 'saving':
      return COPY.saidSaving;
    case 'compiling':
      return COPY.saidCompiling;
    case 'done':
      return COPY.saidDone;
    case 'error':
      return COPY.saidError;
    default:
      return COPY.saidIdle;
  }
}

/** "Password", "Authenticator key" or "Access code". */
export function kindWord(kind) {
  return kind === 'totp' ? COPY.kindTotp : kind === 'token' ? COPY.kindToken : COPY.kindPassword;
}

/** "Configured" or "Missing". */
export function configuredText(configured) {
  return configured === true ? COPY.configured : COPY.missing;
}

/**
 * The plain-language name of a secret: `CRM_PASSWORD` becomes "Crm password".
 * @param {string} name
 */
export function displayName(name) {
  const words = String(name).replace(/_+/g, ' ').trim().toLowerCase();
  return words === '' ? String(name) : words.charAt(0).toUpperCase() + words.slice(1);
}

/** "1 step", "3 steps". @param {number} count */
export function stepCountText(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return n === 1 ? '1 step' : `${n} steps`;
}

/** Why a credential request failed, from its status (0 = no answer, -1 = network). @param {number} status */
export function reasonFor(status) {
  if (status === 400) return COPY.reasonInvalid;
  if (status === 401 || status === 403) return COPY.reasonNotAllowed;
  if (status === 503) return COPY.reasonUnavailable;
  if (status === 0) return COPY.reasonNoAnswer;
  return COPY.reasonOther;
}

/** Every text this module can produce, for the plain-language lint. */
export function allCopyTexts() {
  const texts = Object.values(COPY);
  for (const state of RECORDING_STATES) {
    texts.push(statusText('recording', state), announceText('recording', state));
  }
  for (const state of COMPILE_STATES) {
    for (const phase of COMPILE_PHASES) texts.push(statusText('compile', state, phase), announceText('compile', state, phase));
  }
  for (const kind of SECRET_KINDS) texts.push(kindWord(kind));
  texts.push(configuredText(true), configuredText(false), stepCountText(0), stepCountText(1), stepCountText(7));
  for (const status of [0, 400, 401, 403, 500, 503]) texts.push(reasonFor(status));
  return texts;
}
