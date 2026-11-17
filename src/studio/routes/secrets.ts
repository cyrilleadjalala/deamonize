/**
 * The Credentials routes: the list of secrets the actions need, and save or forget of one value.
 * A response holds names and a `configured` flag, never a value. All routes are blocked for a remote listener.
 */
import { VaultUnavailableError } from '../contracts.js';
import {
  SECRET_APPLICATION_INVALID,
  SECRET_NAME_INVALID,
  SECRET_NOT_REQUIRED,
  SECRET_TOTP_INVALID,
  SECRET_UNAVAILABLE,
  SECRET_UNEXPECTED_FIELD,
  SECRET_UNKNOWN,
  SECRET_VALUE_INVALID,
  SECRET_VALUE_LONG,
  SECRET_VALUE_MISSING,
  SECRET_VALUE_SHORT,
} from '../messages/secrets.js';
import { requiredSecrets } from '../required-secrets.js';
import { extractTotpSecret } from '../totp-secret.js';
import { applicationKey, plainName } from '../validate-action.js';
import type { RouteContext, RouteDef, RouteResponse } from './types.js';

const MAX_VALUE_BYTES = 4096;
const variableOf = (name: string): string => `DAEMONIZE_SECRET_${name.toUpperCase()}`;
const bad = (error: string, field?: string): RouteResponse => ({ status: 400, body: field === undefined ? { error } : { error, field } });

export function secretRoutes(ctx: RouteContext): RouteDef[] {
  const required = async () => requiredSecrets((await ctx.loadSet()).set);
  /** A running Child_Server holds the old environment: end it so that the next call reads the vault again. */
  const stopServer = async (): Promise<void> => {
    if (ctx.playground?.serverStarted === true) await ctx.playground.stopNow();
  };
  /** The Application_Key the request names, 
ull when it names an invalid one, undefined when it names none. */
  const parseApplication = (raw: unknown): string | null | undefined => {
    if (raw === undefined) return undefined;
    return typeof raw === 'string' && applicationKey(raw) === raw ? raw : null;
  };
  const activeKey = async (): Promise<string | undefined> => {
    try {
      return (await ctx.activeApplication()).applicationKey;
    } catch {
      return undefined;
    }
  };
  /** Upper-case variable names that count as configured for an application: names only. */
  const configuredFor = async (application: string | undefined, active: string | undefined): Promise<ReadonlySet<string>> => {
    if (application === undefined || application === active) return ctx.configuredSecretVariables();
    const names = new Set<string>();
    for (const [name, value] of Object.entries(ctx.studioEnv)) {
      if (typeof value === 'string' && value !== '' && /^DAEMONIZE_SECRET_/i.test(name)) names.add(name.toUpperCase());
    }
    for (const name of await ctx.services.vault.namesFor(application)) names.add(variableOf(name));
    return names;
  };
  const unknownField = (body: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(body).some((k) => !allowed.includes(k));

  return [
    {
      path: '/api/secrets',
      remote: 'blocked',
      handlers: {
        GET: async (req) => {
          const asked = parseApplication(req.query.get('application') ?? undefined);
          if (asked === null) return bad(SECRET_APPLICATION_INVALID, 'application');
          const active = await activeKey();
          const application = asked ?? active;
          const configured = await configuredFor(application, active);
          const secrets = (await required()).map((s) => ({ name: s.name, kind: s.kind, configured: configured.has(variableOf(s.name)) }));
          return { status: 200, body: application === undefined ? { secrets } : { application, secrets } };
        },
        POST: async (req) => {
          const body = req.body;
          if (unknownField(body, ['name', 'value', 'application'])) return bad(SECRET_UNEXPECTED_FIELD);
          const application = parseApplication(body.application);
          if (application === null) return bad(SECRET_APPLICATION_INVALID, 'application');
          const name = plainName(body.name);
          if (!name.ok) return bad(SECRET_NAME_INVALID, 'name');
          const known = (await required()).find((s) => s.name === name.value);
          if (known === undefined) return bad(SECRET_NOT_REQUIRED, 'name');
          const raw = body.value;
          if (typeof raw !== 'string' || raw === '') return bad(SECRET_VALUE_MISSING, 'value');
          if (raw.includes('\0')) return bad(SECRET_VALUE_INVALID, 'value');
          if (Buffer.byteLength(raw, 'utf-8') > MAX_VALUE_BYTES) return bad(SECRET_VALUE_LONG, 'value');
          if (raw.length < 3) return bad(SECRET_VALUE_SHORT, 'value');
          let stored = raw;
          if (known.kind === 'totp') {
            const key = extractTotpSecret(raw);
            if (key === undefined) return bad(SECRET_TOTP_INVALID, 'value');
            stored = key;
          }
          try {
            if (application === undefined) await ctx.services.vault.set(known.name, stored);
            else await ctx.services.vault.setFor(application, known.name, stored);
          } catch (err) {
            if (err instanceof VaultUnavailableError) return { status: 503, body: { error: SECRET_UNAVAILABLE } };
            throw err;
          }
          await stopServer();
          return { status: 200, body: { name: known.name, configured: true } };
        },
      },
    },
    {
      path: '/api/secrets/forget',
      remote: 'blocked',
      handlers: {
        POST: async (req) => {
          const body = req.body;
          if (unknownField(body, ['name', 'application'])) return bad(SECRET_UNEXPECTED_FIELD);
          const application = parseApplication(body.application);
          if (application === null) return bad(SECRET_APPLICATION_INVALID, 'application');
          const name = plainName(body.name);
          if (!name.ok) return bad(SECRET_NAME_INVALID, 'name');
          const isRequired = (await required()).some((s) => s.name === name.value);
          if (!isRequired && !(application === undefined ? await ctx.services.vault.has(name.value) : (await ctx.services.vault.namesFor(application)).has(name.value))) return bad(SECRET_UNKNOWN, 'name');
          let removed: boolean;
          try {
            removed = application === undefined ? await ctx.services.vault.remove(name.value) : await ctx.services.vault.removeFor(application, name.value);
          } catch (err) {
            if (err instanceof VaultUnavailableError) return { status: 503, body: { error: SECRET_UNAVAILABLE } };
            throw err;
          }
          if (removed) await stopServer();
          const configured = (await configuredFor(application, application === undefined ? undefined : await activeKey())).has(variableOf(name.value));
          return { status: 200, body: { name: name.value, configured } };
        },
      },
    },
  ];
}
