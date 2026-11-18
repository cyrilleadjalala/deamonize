/** Group G3: `POST /api/record/start`, `GET /api/record/status`, `POST /api/record/stop`. */
import { BODY_MUST_BE_EMPTY, FIELD_NOT_BOOLEAN } from '../messages/record.js';
import { LOAD_UNREADABLE, SAMPLE_MODE, UNEXPECTED_FIELD } from '../messages/common.js';
import { checkSameOrigin } from '../../workflow/origin-guard.js';
import { validateName, validateUrl } from '../validate-action.js';
import type { RouteContext, RouteDef } from './types.js';

const ALLOWED = new Set(['name', 'url', 'reuseSession']);

export function recordRoutes(ctx: RouteContext): RouteDef[] {
  const { recording } = ctx.services;
  return [
    {
      path: '/api/record/start',
      remote: 'blocked',
      // The sample-mode refusal is made by the handler, after the origin check, which writes nothing (12.13)
      writes: false,
      handlers: {
        POST: async ({ body }) => {
          for (const field of Object.keys(body)) {
            if (!ALLOWED.has(field)) return { status: 400, body: { error: UNEXPECTED_FIELD, field } };
          }
          const name = validateName(body.name);
          if (!name.ok) return { status: 400, body: { error: name.message, field: 'name' } };
          const url = validateUrl(body.url);
          if (!url.ok) return { status: 400, body: { error: url.message, field: 'url' } };
          if (body.reuseSession !== undefined && typeof body.reuseSession !== 'boolean') {
            return { status: 400, body: { error: FIELD_NOT_BOOLEAN, field: 'reuseSession' } };
          }
          let existing;
          try {
            existing = (await ctx.loadSet()).set;
          } catch {
            return { status: 409, body: { error: LOAD_UNREADABLE, field: 'url' } };
          }
          const same = checkSameOrigin(existing, url.value);
          if (!same.ok) return { status: 409, body: { error: same.message, field: 'url' } };
          if (ctx.sample) return { status: 409, body: { error: SAMPLE_MODE } };
          const outcome = recording.start({ name: name.value, url: url.value, reuseSession: body.reuseSession === true });
          return outcome.status === 202
            ? { status: 202, body: { state: 'recording' } }
            : { status: 409, body: { error: outcome.message } };
        },
      },
    },
    {
      path: '/api/record/status',
      remote: 'blocked',
      handlers: { GET: async () => ({ status: 200, body: recording.status() }) },
    },
    {
      path: '/api/record/stop',
      remote: 'blocked',
      handlers: {
        POST: async ({ body }) => {
          if (Object.keys(body).length > 0) return { status: 400, body: { error: BODY_MUST_BE_EMPTY } };
          const outcome = recording.stop();
          return outcome.status === 202 ? { status: 202, body: { state: 'saving' } } : { status: 409, body: { error: outcome.message } };
        },
      },
    },
  ];
}
