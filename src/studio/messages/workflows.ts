/** Plain-language texts of the workflow editor routes (POST /api/workflows/update and delete). */
export const WORKFLOW_NOT_FOUND = 'This action was not found. It may already have been deleted.';
export const EDIT_NOTHING_CHANGED = 'Nothing was changed. Give a new name, a new description or a change to an input.';
export const EDIT_ID_INVALID = 'Say which action to change.';
export const EDIT_LABEL_INVALID = 'Enter a name with 1 to 200 characters and no line breaks or other control characters.';
export const EDIT_DESCRIPTION_INVALID =
    'The description must be plain text. Leave out links, formatting marks and instructions, or leave it empty to remove it.';
export const EDIT_VARIABLES_INVALID = 'Change between 1 and 100 inputs, each with the name of an input of this action.';
export const EDIT_VARIABLE_FIELDS = 'An input can only change its name, type, optional setting, behavior when left empty and description.';
export const EDIT_VARIABLE_UNKNOWN = (name: string): string => `This action has no input called "${name}".`;
export const EDIT_VARIABLE_TWICE = (name: string): string => `The input "${name}" appears twice in the request.`;
export const EDIT_NEW_NAME_INVALID =
    'Use letters, numbers and underscores for an input name, start with a letter or an underscore, and use at most 60 characters.';
export const EDIT_NEW_NAME_TAKEN = (name: string): string => `Another input already uses the name "${name}".`;
export const EDIT_TYPE_INVALID = 'The type of an input must be text, number, or true or false.';
export const EDIT_TYPE_RESTRICTED = (name: string): string =>
    `The input "${name}" has a fixed list of values, a pattern or a length limit, so it must stay text.`;
export const EDIT_TYPE_CHECK = (name: string): string => `The input "${name}" is a yes or no check, so it must stay true or false.`;
export const EDIT_FLAG_INVALID = 'Optional must be true or false.';
export const EDIT_WHEN_OMITTED_INVALID = 'The choice for an empty input must be to skip it or to use the recorded value.';
export const EDIT_WHEN_OMITTED_REQUIRED = (name: string): string =>
    `The input "${name}" must be optional before you say what happens when it is left empty.`;
export const EDIT_VARIABLE_DESCRIPTION_INVALID = (name: string): string =>
    `The description of the input "${name}" must be plain text without links, formatting marks or instructions.`;
export const EDIT_COERCE_FAILED = (name: string): string =>
    `The values saved for the input "${name}" cannot be turned into the new type, so nothing was changed.`;
export const EDIT_NOT_SAVED = 'The change was not saved. Nothing in the file was changed. You can try again.';
export const EDIT_REFUSED_CONTENT = 'The change was refused because the file would not be valid. Nothing was changed.';
export const EDIT_RUNNING_RECORDING = 'A recording is in progress. Finish it before you change an action.';
export const EDIT_RUNNING_BUILD = 'The tool is being built. Wait until it is finished before you change an action.';
export const DELETE_ID_INVALID = 'Say which action to delete, with an id of 1 to 200 characters.';
export const DELETE_NOT_SAVED = 'The action was not deleted. Nothing in the file was changed. You can try again.';
