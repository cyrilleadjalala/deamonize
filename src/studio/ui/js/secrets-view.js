// @ts-check
/**
 * The secrets of a workflow or tool, by name only: the ones the compiled server reads (with `configured` or
 * `missing`), and the names recorded in HTTP recipes that it never reads. Built with the safe `h()` builders:
 * no innerHTML, and no value is ever available here, only names and the two words `configured` and `missing`.
 * Every input is optional: the static demo and old servers send neither `status`, `unusedSecrets` nor `basis`.
 */
import { h } from './dom.js';
import { chip } from './components.js';

/**
 * @typedef {{ name: string, kind?: string, envVariable?: string, status?: 'configured' | 'missing' }} SecretItem
 */

/** @param {SecretItem} secret */
const variableOf = (secret) => secret.envVariable ?? `DAEMONIZE_SECRET_${secret.name}`;

/**
 * @param {SecretItem[] | undefined} secrets Required by the compiled mode.
 * @param {SecretItem[] | undefined} unusedSecrets Recorded in HTTP recipes, not read by the compiled mode.
 * @param {{ basis?: string, variant?: 'workflow' | 'playground', heading?: boolean }} [options]
 *   `heading` adds the "Provided by env" title (default: true for the playground variant; the workflow view puts
 *   the list in its "Secrets needed" panel).
 * @returns {HTMLElement}
 */
export function secretsSection(secrets, unusedSecrets, options = {}) {
  const variant = options.variant === 'playground' ? 'playground' : 'workflow';
  const required = Array.isArray(secrets) ? secrets : [];
  const unused = Array.isArray(unusedSecrets) ? unusedSecrets : [];
  const heading = options.heading ?? variant === 'playground';
  const missing = required.filter((s) => s.status === 'missing');

  const list = required.length
    ? h(
        'ul',
        { class: 'plain-list secrets-list' },
        ...required.map((s) =>
          h(
            'li',
            { dataset: { secret: s.name } },
            chip(s.name, 'secret'),
            s.kind ? h('span', { class: 'muted', text: ` ${s.kind}` }) : null,
            h('span', { class: 'muted', text: ` ${variantNote(variant, s)} ` }),
            s.status === 'configured' ? chip('configured', 'pass') : s.status === 'missing' ? chip('missing', 'fail') : null
          )
        )
      )
    : h('p', { class: 'muted', text: 'No secret needed.' });

  const unusedBlock = unused.length
    ? h(
        'details',
        { class: 'secrets-unused' },
        h('summary', { text: 'Recorded in HTTP recipes, not read by this server' }),
        h('ul', { class: 'plain-list' }, ...unused.map((s) => h('li', null, chip(s.name, 'secret'), h('span', { class: 'muted', text: ` ${variableOf(s)}` }))))
      )
    : null;

  return h(
    'section',
    { class: 'secrets-section', dataset: { variant, basis: options.basis }, 'aria-label': 'Secrets provided by the environment' },
    heading ? h('h4', { class: 'mini-title', text: 'Provided by env' }) : null,
    options.basis === 'not-compiled' ? h('p', { class: 'muted small', text: 'Compile to see which secrets the server reads.' }) : null,
    list,
    variant === 'playground' && missing.length > 0
      ? h('p', { class: 'muted small', text: 'Set it before calling the tool: the call fails with missing_secret.' })
      : null,
    unusedBlock
  );
}

/** @param {'workflow' | 'playground'} variant @param {SecretItem} secret */
function variantNote(variant, secret) {
  return variant === 'playground'
    ? `read from ${variableOf(secret)} in the Studio\u2019s environment. Its value is never shown.`
    : variableOf(secret);
}
