// @ts-check
/**
 * Plain-language texts of the workflow editor (rename, describe, edit inputs, delete).
 * The plain-language lint reads `allEditorCopyTexts()`. No text here ever holds a value typed by the user.
 */
export const COPY_EDITOR = {
  // ----- the three controls ------------------------------------------------------------------------------------
  renameButton: 'Rename and describe',
  inputsButton: 'Edit inputs',
  deleteButton: 'Delete this action',
  // ----- start page -------------------------------------------------------------------------------------------
  startPageLabel: 'Start page',
  // ----- rename and describe ----------------------------------------------------------------------------------
  renameTitle: 'Rename and describe this action',
  nameLabel: 'Name',
  descriptionLabel: 'Description',
  descriptionHelp: 'Say what this action does. An AI assistant reads this text. Use plain text, without links.',
  // ----- edit inputs ------------------------------------------------------------------------------------------
  inputsTitle: 'Edit inputs',
  inputsLead: 'Change the name, the type or the optional setting of an input.',
  inputsNone: 'This action takes no input.',
  typeLabel: 'Type',
  typeText: 'Text',
  typeNumber: 'Number',
  typeBoolean: 'True or false',
  optionalLabel: 'Optional',
  whenOmittedLabel: 'If left empty',
  whenSkip: 'Skip this field',
  whenUseRecorded: 'Use the recorded value',
  // ----- buttons and states -----------------------------------------------------------------------------------
  save: 'Save',
  saving: 'Saving\u2026',
  cancel: 'Cancel',
  nothingChanged: 'Nothing was changed.',
  updated: 'The action was updated.',
  notSaved: 'The change was not saved. Nothing was changed. Check that the Studio is still running, then try again.',
  rebuilding: 'The tool is being rebuilt with your change. This can take a minute.',
  // ----- delete dialog ----------------------------------------------------------------------------------------
  deleteTitle: 'Delete this action?',
  deleteBefore: 'You are about to delete ',
  deleteAfter: '.',
  deleteWarning: 'The Studio cannot bring it back once it is deleted.',
  deleteConfirm: 'Delete',
  deleteWorking: 'Deleting\u2026',
  deleteNotSaved: 'The action was not deleted. Nothing was changed. Check that the Studio is still running, then try again.',
  deleted: 'The action was deleted.',
};
/** Every text of this module, for the plain-language lint. */
export function allEditorCopyTexts() {
  return Object.values(COPY_EDITOR);
}
