// @ts-check
/**
 * Plain-language texts of the credentials screen (per application) and of the Playground auto-add line.
 * The plain-language lint reads `allSecretsCopyTexts()`. No text here ever holds a secret value.
 */

export const COPY_SECRETS = {
  applicationLine: 'These passwords are for',
  applicationUnknown: 'These passwords are not tied to one application yet.',
  hasValue: 'has a value',
  hasNoValue: 'has no value yet',
  autoAddAdded: 'This tool was added to Kiro. Reload Kiro to see it.',
  autoAddFailed: 'This tool could not be added to Kiro automatically. Your Kiro files were left as they were.',
};

/**
 * The host of an application origin, for display ("cycyly.vercel.app"). Empty string when there is none.
 * @param {unknown} application
 */
export function applicationHost(application) {
  if (typeof application !== 'string' || application === '') return '';
  try {
    return new URL(application).host;
  } catch {
    return '';
  }
}

/** "These passwords are for cycyly.vercel.app", or a neutral line when no application is known. @param {unknown} application */
export function applicationText(application) {
  const host = applicationHost(application);
  return host === '' ? COPY_SECRETS.applicationUnknown : `${COPY_SECRETS.applicationLine} ${host}`;
}

/** "has a value" or "has no value yet". @param {boolean} configured */
export function valueStatusText(configured) {
  return configured === true ? COPY_SECRETS.hasValue : COPY_SECRETS.hasNoValue;
}

/**
 * The line for the auto-add result of a Playground call: only `added` and `failed` show a line.
 * @param {any} autoAdd
 * @returns {string | null}
 */
export function autoAddText(autoAdd) {
  if (autoAdd?.status === 'added') return COPY_SECRETS.autoAddAdded;
  if (autoAdd?.status === 'failed') return COPY_SECRETS.autoAddFailed;
  return null;
}

/** Every text of this module, for the plain-language lint. */
export function allSecretsCopyTexts() {
  return [...Object.values(COPY_SECRETS), applicationText('https://example.com'), valueStatusText(true), valueStatusText(false)];
}
