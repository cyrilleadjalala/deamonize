// @ts-check
/**
 * Which credentials sentence the success screen shows. No imports, so tests and the extension can load it alone.
 * @param {any} result the answer of `POST /api/power/install`
 * @param {any} [preview] the answer of `POST /api/power/preview` (read when the install answer has no `requiredSecrets`)
 * @returns {'placeholders' | 'vault' | 'none' | 'unknown'}
 */
export function credentialsNotice(result, preview) {
  if (Array.isArray(result?.placeholders) && result.placeholders.length > 0) return 'placeholders';
  const required = Array.isArray(result?.requiredSecrets) ? result.requiredSecrets : Array.isArray(preview?.requiredSecrets) ? preview.requiredSecrets : undefined;
  if (required === undefined) return 'unknown';
  return required.length > 0 ? 'vault' : 'none';
}
