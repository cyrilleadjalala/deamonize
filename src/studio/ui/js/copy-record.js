// @ts-check
/**
 * Plain-language texts of the recording screens (panel in the page, new-action form, recording status).
 * Filled by the recording groups. The plain-language lint reads `allRecordCopyTexts()`. No text here ever holds a secret value.
 */
export const COPY_RECORD = {
  // ----- new action: another application than the one in this folder (G-E) ----------------------------------------
  foreignOriginBefore: 'This folder already holds actions for ',
  foreignOriginAfter: '. Another application needs another folder.',

  // ----- recording status: credentials still missing after "Save and add to Kiro" (G-E) -----------------------------
  credentialsMissingTitle: 'Credentials are still missing',
  credentialsMissingLead: 'The tool was added to Kiro, but it cannot work yet. Press "Add your credentials" before you use it in Kiro. Missing:',
  credentialsMissingLink: 'Add your credentials',
};
/** The sentence shown when the address belongs to another application than the one in this folder. @param {string} origin */
export function foreignOriginText(origin) {
  return `${COPY_RECORD.foreignOriginBefore}${origin}${COPY_RECORD.foreignOriginAfter}`;
}
/** Every text of this module, for the plain-language lint. */
export function allRecordCopyTexts() {
  return Object.values(COPY_RECORD);
}
