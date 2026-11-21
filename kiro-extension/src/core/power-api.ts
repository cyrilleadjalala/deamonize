import type { PowerApi, StudioClient } from './ports';

/** G0 seam: the signature is final; the body belongs to group G-E1. Calls `/api/power/daemonize/*` and `GET /api/system/browser`. */
export function createPowerApi(_client: StudioClient): PowerApi {
  throw new Error('not implemented: G-E1');
}
