/** Group G4 owns this file: plain-language texts of the compile and power routes. */
export const COMPILE_FAILED_UNCHANGED = 'The tool could not be built. Nothing in the output folder was changed.';
export const COMPILE_FAILED_INCOMPLETE =
    'The tool could not be built, and the output folder may be incomplete. You can run Recompile again.';
export const COMPILE_INSTALL_TIMEOUT = 'Installing the tool\u2019s packages took too long and was stopped. You can run Recompile again.';
export const COMPILE_INSTALL_STOPPED = 'Installing the tool\u2019s packages was stopped because the Studio is closing.';
export const APP_NAME_NOT_SAVED = 'The name of this application could not be saved, so nothing was built. Nothing was changed.';
export const COMPILE_BUSY = 'A build is already running.';
export const COMPILE_BODY_MUST_BE_EMPTY = 'This request takes no fields.';

export const POWER_NOT_COMPILED = 'Build your tool first: there is nothing to connect yet.';
export const POWER_SETTINGS_UNREADABLE = 'The file settings/mcp.json cannot be read as settings';
export const POWER_PATH_INVALID = 'Enter the full path of an existing folder.';
export const POWER_PATH_NOT_FOLDER = 'That path is not a folder that exists.';
export const POWER_PATH_NOT_ALLOWED = 'That folder cannot be used as a workspace.';
export const POWER_KIRO_OUTSIDE = 'The .kiro folder in that workspace points outside it, so nothing was written.';
export const POWER_TARGET_LINK = 'A file that would be written is a link, so nothing was written.';
export const POWER_CONFIRM_INVALID = 'The confirmation is missing, expired or does not match. Check the preview again.';
export const POWER_WRITE_FAILED = 'The files could not be written. Your existing settings were left as they were.';
export const POWER_FIELD_REQUIRED = 'Enter the workspace folder.';
