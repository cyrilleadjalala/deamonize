/**
 * Every user-facing text of the extension, in plain language (no "record", "compile", "token", "CLI", "MCP", "JSON").
 * Texts with a name or a path are small functions. `CONTRIBUTION_STRINGS` is the source of `package.nls.json`.
 */
export const S = Object.freeze({
  // Fixed by the requirements
  credentialsFromVault: 'This tool will use the passwords you saved in Daemonize. Nothing else to set up.',
  noCredentials: 'This tool needs no credentials.',
  riskRead: 'Reads only',
  riskWrite: 'Changes data',
  riskDelete: 'Deletes data',
  hasValue: 'has a value',
  hasNoValue: 'has no value yet',

  // Button names
  restart: 'Restart',
  start: 'Start',
  newAction: 'New action',
  tryAgain: 'Try again',
  chooseFile: 'Choose the file',
  openSettings: 'Open settings',
  openFolder: 'Open a folder',
  finish: 'Finish',
  confirmConnect: 'Connect',
  confirmForget: 'Forget',
  confirmRemove: 'Remove',

  // Status
  statusStopped: 'Daemonize is not running',
  statusStarting: 'Daemonize is starting',
  statusRunning: 'Daemonize is running',
  statusCrashed: 'Daemonize stopped unexpectedly',
  statusRecording: (steps: number): string => `Recording: ${steps} ${steps === 1 ? 'step' : 'steps'}`,

  // Tree views
  noFolder: 'Open a folder to use Daemonize.',
  noActions: 'No actions yet. Create one with "New action".',
  noCredentialsYet: 'No credentials are needed yet.',
  notConnectedYet: 'Not connected to Kiro yet',
  connectsWholeApplication: 'Connects all actions of this application to Kiro',
  notInstalled: 'Not connected to Kiro',
  loadFailed: 'Daemonize could not load this list. Try again.',
  startToSee: 'Start Daemonize to see this list.',
  scopeGlobal: 'All projects',
  scopeProject: 'This project only',

  // Start and stop
  cliMissing: (path: string): string => `Daemonize could not be found${path ? ` at ${path}` : ''}. Install it, or choose the file.`,
  cliConfiguredMissing: (path: string): string => `The file ${path} does not exist. Choose another file or clear the setting.`,
  cliUnsupportedShim: (path: string): string => `The file ${path} cannot be started. Choose the file that ends in .js or .exe.`,
  cliTooOld: 'This version of Daemonize is too old for the extension. Update it, then try again.',
  startTimeout: 'Daemonize did not answer in time. Try again.',
  startFailed: 'Daemonize could not start. See the Daemonize log for details.',
  exitedEarly: 'Daemonize stopped right after starting. See the Daemonize log for details.',
  restartedTryAgain: 'Daemonize was restarted. Try again.',
  noWorkspaceFolder: 'Open a folder first. Daemonize saves its files there.',
  severalFolders: 'Several folders are open. Daemonize uses the first one.',
  folderNotLocal: 'Daemonize works only with folders on this computer.',
  folderChanged: 'The folder changed, so Daemonize was stopped.',
  stopped: 'Daemonize was stopped.',
  browserNotOpened: 'The browser could not be opened. Open the Studio from the Daemonize view again.',
  unauthorized: 'Daemonize no longer accepts this session.',
  networkError: 'Daemonize could not be reached. Try again.',

  // New action
  namePrompt: 'Name of the action',
  namePlaceholder: 'For example: Create invoice',
  urlPrompt: 'Address of the web page to start from',
  urlPlaceholder: 'https://example.com',
  reuseSessionPick: 'Use the sign-in you already saved?',
  reuseYes: 'Yes, reuse it',
  reuseNo: 'No, sign in again',
  recordingStarted: 'A browser window opened. Do the task once, then choose "Finish".',
  recordingAlready: 'An action is already being created. Finish it first.',
  recordingNone: 'No action is being created.',
  recordingSaving: 'Saving your action',
  recordingBuilding: 'Building your action',
  recordingSaved: (name: string): string => `"${name}" is ready.`,
  recordingFailed: (reason: string): string => `The action could not be created: ${reason}`,
  recordingGaveUp: 'Daemonize lost track of the action being created. Check the Daemonize view.',
  recordingNoLongerStarts: 'Could not start. Try again.',

  // Credentials
  setCredentialPrompt: (name: string): string => `Value for ${name}`,
  pickCredential: 'Choose a credential',
  credentialSaved: (name: string): string => `${name} was saved.`,
  credentialForgotten: (name: string): string => `${name} was forgotten.`,
  credentialNotSaved: 'The value could not be saved. Try again.',
  forgetConfirm: (name: string): string => `Forget ${name}?`,
  forgetDetail: 'The saved value is deleted from this computer. Tools that need it will stop working until you set it again.',

  // Connect to Kiro
  connectConfirm: 'Connect to Kiro?',
  connectScopePick: 'Where should the tools be available?',
  connected: 'Connected to Kiro.',
  connectFailed: (reason: string): string => `Could not connect to Kiro: ${reason}`,
  connectMissing: (names: string): string => `Still missing: ${names}. Set them in the Credentials list.`,
  connectPlaceholders: (names: string): string => `Add a value for ${names} in your Kiro settings.`,
  connectUnavailable: 'Nothing to connect yet. Create an action first.',
  removeConfirm: 'Remove from Kiro?',
  removeDetail: 'Kiro will no longer see these tools. Your actions stay in this folder.',
  removed: 'Removed from Kiro.',
  previewPath: (path: string): string => `Folder: ${path}`,
  previewCreate: 'will be created',
  previewMerge: 'will be merged',
  previewReplace: 'will be replaced',
  previewReplacesEntry: 'An earlier connection of this application will be replaced.',
  previewMissing: (names: string): string => `Credentials with no value yet: ${names}`,
  previewBackup: 'A backup of the existing file is kept.',

  // Delete an action
  confirmDelete: 'Delete',
  deleteConfirm: (name: string): string => `Delete "${name}"?`,
  deleteDetail: 'This action cannot be recovered from the Studio.',
  actionDeleted: (name: string): string => `"${name}" was deleted.`,
  actionDeletedUpdating: (name: string): string => `"${name}" was deleted. Its tools are being updated.`,
  actionGone: 'This action no longer exists.',
  deleteBusy: 'Daemonize is busy right now. Try again in a moment.',
  deleteFailed: 'The action could not be deleted. Try again.',
  deleteNoAnswer: 'Daemonize did not answer in time. Check the Actions list, then try again.',

  // Log
  logChannel: 'Daemonize',
});

export type Strings = typeof S;

/** The texts of the manifest, keyed as in `package.nls.json`. Never edit `package.nls.json` by hand. */
export const CONTRIBUTION_STRINGS: Readonly<Record<string, string>> = Object.freeze({
  'extension.description': 'Create, test and connect Daemonize tools from the Kiro sidebar.',
  'capabilities.untrusted': 'Daemonize starts a program from the open folder, so it needs a trusted folder.',
  'capabilities.virtual': 'Daemonize works only with folders on this computer.',
  'container.title': 'Daemonize',
  'view.actions': 'Actions',
  'view.credentials': 'Credentials',
  'view.kiro': 'Kiro',
  'welcome.noFolder': 'Open a folder to use Daemonize.\n[Open a folder](command:vscode.openFolder)',
  'command.start': 'Start Daemonize',
  'command.stop': 'Stop Daemonize',
  'command.restart': 'Restart Daemonize',
  'command.openStudio': 'Open the Studio',
  'command.testInStudio': 'Test in the Studio',
  'command.deleteAction': 'Delete this action',
  'command.newAction': 'New action',
  'command.finishRecording': 'Finish the action',
  'command.refresh': 'Refresh',
  'command.connectToKiro': 'Connect to Kiro',
  'command.removeFromKiro': 'Remove from Kiro',
  'command.setCredential': 'Set a credential',
  'command.forgetCredential': 'Forget a credential',
  'command.showLog': 'Show the Daemonize log',
  'command.chooseCliFile': 'Choose the Daemonize file',
  'config.cliPath': 'Path of the Daemonize program. Leave empty to find it automatically.',
  'config.nodePath': 'Path of Node. Leave empty to find it automatically.',
});
