/** Plain-language texts of the Power routes. No value, key, stack trace or path outside the shown `.kiro` folder. */
export {
  POWER_CONFIRM_INVALID,
  POWER_FIELD_REQUIRED,
  POWER_KIRO_OUTSIDE,
  POWER_NOT_COMPILED,
  POWER_PATH_INVALID,
  POWER_PATH_NOT_ALLOWED,
  POWER_PATH_NOT_FOLDER,
  POWER_SETTINGS_UNREADABLE,
  POWER_TARGET_LINK,
  POWER_WRITE_FAILED,
} from './compile.js';

export const POWER_SCOPE_INVALID = 'Choose either all your projects or only this project.';
export const POWER_UNEXPECTED_FIELD = 'Unexpected field.';
export const POWER_SETTINGS_TOO_LARGE = 'The file settings/mcp.json is too large to be changed safely, so nothing was written.';
export const POWER_SETTINGS_NOT_JSON = 'The file settings/mcp.json is not valid settings text, so nothing was changed. Fix or remove that file first.';
export const POWER_SETTINGS_NOT_OBJECT = 'The file settings/mcp.json does not hold a settings object, so nothing was changed. Fix or remove that file first.';
export const POWER_SETTINGS_SERVERS_NOT_OBJECT = 'The list of servers in settings/mcp.json is not in the expected form, so nothing was changed. Fix that file first.';
export const POWER_NOTHING_TO_REMOVE = 'This tool was not added to Kiro from here, so there is nothing to remove.';
export const POWER_REMOVE_FAILED = 'The tool could not be removed. Your Kiro files were left as they were.';
export const POWER_AUTO_ADD_FAILED = 'The tool could not be added to Kiro automatically. Your Kiro files were left as they were.';
export const POWER_AUTO_ADD_NOT_SAVED = 'Your choice to add the tool automatically could not be remembered, so the option stays off.';
