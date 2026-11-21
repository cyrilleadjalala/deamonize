// @ts-check
/**
 * The approval banner (questions waiting for an answer). G0 seam: an empty body; group G-U1 fills it and keeps the export.
 */
/**
 * Polls the pending questions while mounted and draws them in `container`. Returns the function that stops it.
 * @param {HTMLElement} _container
 * @returns {() => void}
 */
export function mountApprovalBanner(_container) {
  return () => undefined;
}
