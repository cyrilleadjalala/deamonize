// @ts-check
/**
 * Plain-language texts of the replay timeline. The plain-language lint reads `allTimelineCopyTexts()`.
 */
export const COPY_TIMELINE = {
  listLabel: 'Replay timeline',
  simpleLabel: 'Steps of the call',
  stepWord: 'Step',
  levelHttp: 'Direct request',
  levelAccessibility: 'Page controls',
  levelVision: 'Picture match',
  levelTerminal: 'Terminal',
  levelSkipped: 'Skipped',
  levelNotRun: 'Not run',
  statusOk: 'Done',
  statusFailed: 'Failed',
  statusDrifted: 'Drifted',
  statusSkipped: 'Skipped',
  statusNotRun: 'Not run',
  statusBlocked: 'Blocked',
  drifted: 'Drifted',
  blocked: 'Blocked: not run again',
  skipped: 'Skipped (optional value left out)',
  stoppedByApproval: 'Stopped by Ask before changes',
  noPicture: 'No picture',
  pictureAlt: 'Recorded screen of step',
  failureAlt: 'Page at the failing step',
  reasonLabel: 'Reason',
  noteLabel: 'Note',
  levelLabel: 'Level',
  statusLabel: 'Status',
  durationLabel: 'Duration',
  truncated: 'Only the first steps are shown.',
};

/** @param {number} n */
export function pictureAltText(n) {
  return `${COPY_TIMELINE.pictureAlt} ${n}`;
}

/** @param {number} ms */
export function durationText(ms) {
  const v = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
}

/** Every text of this module, for the plain-language lint. */
export function allTimelineCopyTexts() {
  return [...Object.values(COPY_TIMELINE), pictureAltText(1), durationText(0), durationText(1500)];
}
