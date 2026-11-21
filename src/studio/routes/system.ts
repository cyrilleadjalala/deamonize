/** `GET /api/system/browser`: which browser a replay would use. Read-only, loopback only, no path. */
import { BROWSER_UNEXPECTED_FIELD } from '../messages/system.js';
import { redactForStudio } from '../redact.js';
import type { RouteContext, RouteDef } from './types.js';

export function systemRoutes(ctx: RouteContext): RouteDef[] {
  const { browser, vault } = ctx.services;
  return [
    {
      path: '/api/system/browser',
      remote: 'blocked',
      handlers: {
        GET: async (req) => {
          for (const name of req.query.keys()) {
            return { status: 400, body: { error: BROWSER_UNEXPECTED_FIELD, field: name } };
          }
          const answer = await browser.check();
          return { status: 200, body: redactForStudio(answer, { env: ctx.studioEnv, secretValues: vault.values() }) };
        },
      },
    },
  ];
}
