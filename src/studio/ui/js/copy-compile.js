// @ts-check
/**
 * Plain-language texts of the compile options (web address mode and self-repair) of the recompile screen.
 * The plain-language lint reads `allCompileCopyTexts()`.
 */
export const COPY_COMPILE = {
  advancedTitle: 'Advanced options',
  optionHttp: 'Run recorded requests directly (faster, no page)',
  optionHeal: 'Repair steps with a vision model when a page changes',
  httpNote: 'Requests that change data are sent as recorded and are not retried on the page.',
  healNote:
    'The repair needs a model to be set up when the tool runs. Without one, the tool stops with "heal unavailable" on the step that needs repair.',
  terminalNote: 'These options apply to web actions only.',
};

/** Every text of this module, for the plain-language lint. */
export function allCompileCopyTexts() {
  return Object.values(COPY_COMPILE);
}
