/** Plain-language texts of `GET /api/approvals` and `POST /api/approvals/decide`. No value, key or path. */
export const APPROVAL_ENDED = 'This question has already ended.';
export const APPROVAL_ID_INVALID = 'The question is not recognized.';
export const APPROVAL_DECISION_INVALID = 'Answer either Approve or Deny.';
export const APPROVAL_UNEXPECTED_FIELD = 'Unexpected field.';
export const APPROVAL_UNAVAILABLE = 'Questions about changes are not available here, because the folder where Daemonize keeps its data cannot be used.';
/** Shown with the risk of a request. */
export const RISK_TEXT = { write: 'Changes data', delete: 'Deletes data' } as const;
