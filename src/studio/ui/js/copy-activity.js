// @ts-check
/**
 * Plain-language texts of the Activity view and the approval banner. The plain-language lint reads
 * `allActivityCopyTexts()`. Keep `COPY_ACTIVITY.title` and `allActivityCopyTexts()`.
 */
export const COPY_ACTIVITY = {
  title: 'Activity',
  lead: 'What Kiro did with your tools, newest first.',
  empty: 'No calls yet. When Kiro uses one of your tools, it appears here.',
  emptyFiltered: 'No call matches these filters.',
  loadFailed: 'The activity could not be loaded.',
  filtersLabel: 'Filter the activity',
  filterTool: 'Tool',
  filterDecision: 'Answer',
  filterAll: 'All',
  clearFilters: 'Show everything',
  tableLabel: 'Calls of your tools',
  colTime: 'Time',
  colTool: 'Tool',
  colRisk: 'Effect',
  colDecision: 'Answer',
  colOutcome: 'Result',
  colDuration: 'Duration',
  colDetails: 'Details',
  show: 'Show details',
  hide: 'Hide details',
  argumentsTitle: 'What was sent',
  noArguments: 'Nothing was sent.',
  stepsTitle: 'Steps',
  applicationLabel: 'Application',
  sourceKiro: 'Asked by Kiro',
  sourceStudio: 'Asked from Studio',
  riskRead: 'Reads data',
  riskWrite: 'Changes data',
  riskDelete: 'Deletes data',
  decisionAuto: 'Ran without asking',
  decisionApproved: 'You approved',
  decisionDenied: 'You denied',
  decisionTimeout: 'No answer in time',
  decisionUnavailable: 'Could not ask you',
  outcomeSuccess: 'Worked',
  outcomeFailed: 'Failed',
  outcomeDenied: 'Stopped: you denied it',
  outcomeTimeout: 'Stopped: no answer in time',
  outcomeUnavailable: 'Stopped: nobody could be asked',
  showing: 'Showing',
  of: 'of',
  calls: 'calls',
  // Approval banner
  bannerLabel: 'Questions waiting for you',
  bannerTitle: 'Kiro wants to use a tool',
  toolLabel: 'Tool',
  changesDataLabel: 'Changes data',
  argumentsLabel: 'What will be sent',
  writeStepsLabel: 'Steps that change data',
  secondsLeft: 'Seconds left',
  approve: 'Approve',
  deny: 'Deny',
  sampleNote: 'This is an example. You cannot answer it here.',
  decideFailed: 'Your answer could not be sent. Try again.',
  alreadyEnded: 'This question has already ended.',
  waitingForResult: 'Waiting for the result.',
  resultWorked: 'It worked.',
  resultFailed: 'It failed.',
};

/** @param {string} tool @returns {string} */
export const announceNewRequest = (tool) => `Kiro asks to use ${tool}. Approve or deny it.`;
/** @param {string} tool @returns {string} */
export const announceApproved = (tool) => `You approved ${tool}.`;
/** @param {string} tool @returns {string} */
export const announceDenied = (tool) => `You denied ${tool}.`;
/** @param {string} tool @returns {string} */
export const announceEnded = (tool) => `The question about ${tool} has ended.`;
/** @param {string} tool @param {boolean} worked @returns {string} */
export const announceResult = (tool, worked) => `${tool}: ${worked ? COPY_ACTIVITY.resultWorked : COPY_ACTIVITY.resultFailed}`;

/** @param {string} risk @returns {string} */
export function riskText(risk) {
  return risk === 'delete' ? COPY_ACTIVITY.riskDelete : risk === 'write' ? COPY_ACTIVITY.riskWrite : COPY_ACTIVITY.riskRead;
}

/** The four answers and the automatic one, as words. @param {string} decision @returns {string} */
export function decisionText(decision) {
  switch (decision) {
    case 'approved': return COPY_ACTIVITY.decisionApproved;
    case 'denied': return COPY_ACTIVITY.decisionDenied;
    case 'timeout': return COPY_ACTIVITY.decisionTimeout;
    case 'unavailable': return COPY_ACTIVITY.decisionUnavailable;
    default: return COPY_ACTIVITY.decisionAuto;
  }
}

/** @param {string} outcome @returns {string} */
export function outcomeText(outcome) {
  switch (outcome) {
    case 'success': return COPY_ACTIVITY.outcomeSuccess;
    case 'approval_denied': return COPY_ACTIVITY.outcomeDenied;
    case 'approval_timeout': return COPY_ACTIVITY.outcomeTimeout;
    case 'approval_unavailable': return COPY_ACTIVITY.outcomeUnavailable;
    default: return COPY_ACTIVITY.outcomeFailed;
  }
}

/** @param {number} ms @returns {string} */
export function durationText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** Every text of this module, for the plain-language lint. */
export function allActivityCopyTexts() {
  return [
    ...Object.values(COPY_ACTIVITY),
    announceNewRequest('a tool'), announceApproved('a tool'), announceDenied('a tool'), announceEnded('a tool'), announceResult('a tool', true), announceResult('a tool', false),
    ...['read', 'write', 'delete'].map(riskText),
    ...['auto', 'approved', 'denied', 'timeout', 'unavailable'].map(decisionText),
    ...['success', 'failed', 'approval_denied', 'approval_timeout', 'approval_unavailable'].map(outcomeText),
  ];
}
