import type { InstallAnswer, PreviewAnswer } from '../types';

export type CredentialsNotice = 'placeholders' | 'vault' | 'none' | 'unknown';

/** Same decision table as src/studio/ui/js/credentials-notice.js. */
export function credentialsNotice(result: Partial<InstallAnswer> | undefined, preview?: Partial<PreviewAnswer>): CredentialsNotice {
  if (Array.isArray(result?.placeholders) && result.placeholders.length > 0) return 'placeholders';
  const required = Array.isArray(result?.requiredSecrets)
    ? result.requiredSecrets
    : Array.isArray(preview?.requiredSecrets)
      ? preview.requiredSecrets
      : undefined;
  if (required === undefined) return 'unknown';
  return required.length > 0 ? 'vault' : 'none';
}
