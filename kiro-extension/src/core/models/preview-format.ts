import { S } from '../strings';
import type { PreviewAnswer } from '../types';

const OUTCOME: Record<'create' | 'merge' | 'replace', string> = {
  create: S.previewCreate,
  merge: S.previewMerge,
  replace: S.previewReplace,
};

/** The text of the confirmation: the folder, each file with its outcome, the replacement, missing names and the backup. */
export function previewDetail(p: PreviewAnswer): string {
  const lines: string[] = [S.previewPath(p.kiroPath), ''];
  for (const f of p.files) lines.push(`${f.path} ${OUTCOME[f.outcome]}`);
  if (p.replacesEntry) lines.push('', S.previewReplacesEntry);
  if (p.missingSecrets.length > 0) lines.push('', S.previewMissing(p.missingSecrets.join(', ')));
  if (p.backup) lines.push('', S.previewBackup);
  return lines.join('\n');
}
