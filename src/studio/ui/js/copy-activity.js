// @ts-check
/**
 * Plain-language texts of the Activity view and the approval banner. G0 seam: group G-U1 fills the texts and keeps
 * `COPY_ACTIVITY.title` and `allActivityCopyTexts()`. The plain-language lint reads `allActivityCopyTexts()`.
 */
export const COPY_ACTIVITY = {
  title: 'Activity',
};
/** Every text of this module, for the plain-language lint. */
export function allActivityCopyTexts() {
  return Object.values(COPY_ACTIVITY);
}
