/**
 * The activity service of the Studio: reads the Audit_Log through `readAuditEntries`.
 */
import { AUDIT_MAX_ENTRIES, readAuditEntries } from '../replay/runtime/audit-log.js';
import type { ActivityService, AppData } from './contracts.js';

export interface ActivityServiceDeps {
  appData: AppData;
}

export function createActivityService(deps: ActivityServiceDeps): ActivityService {
  return {
    async list(query) {
      const empty = { entries: [], tools: [] as string[], total: 0 };
      try {
        const check = await deps.appData.check();
        if (!check.ok) return empty;
        // The whole log is read (at most 1000 entries): the tool list and the total cover every call, not one page
        const all = await readAuditEntries(check.dir, { limit: AUDIT_MAX_ENTRIES });
        const tools = [...new Set(all.map((e) => e.tool))].sort();
        const matching = all.filter((e) => (query.tool === undefined || e.tool === query.tool) && (query.decision === undefined || e.decision === query.decision));
        return { entries: matching.slice(0, query.limit), tools, total: matching.length };
      } catch {
        return empty;
      }
    },
  };
}
