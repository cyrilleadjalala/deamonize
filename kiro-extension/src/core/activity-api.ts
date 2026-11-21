import type { ActivityApi, StudioClient } from './ports';

/** G0 seam: the signature is final; the body belongs to group G-E2. Reads `GET /api/approvals` and `GET /api/activity` only. */
export function createActivityApi(_client: StudioClient): ActivityApi {
  throw new Error('not implemented: G-E2');
}
