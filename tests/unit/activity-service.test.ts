import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../src/replay/runtime/audit-log.js';
import { sampleAuditEntries } from '../../src/studio/sample-activity.js';

// A local fake of the reader (design: newest first); the real one belongs to group G-B
const fake = vi.hoisted(() => ({ entries: [] as unknown[], calls: [] as unknown[] }));
vi.mock('../../src/replay/runtime/audit-log.js', () => ({
  AUDIT_MAX_ENTRIES: 1000,
  readAuditEntries: async (dir: string, options?: { limit?: number }) => {
    fake.calls.push({ dir, options });
    return fake.entries.slice(0, options?.limit ?? fake.entries.length);
  },
}));

import { createActivityService } from '../../src/studio/activity-service.js';
import type { AppData } from '../../src/studio/contracts.js';

const appData = (ok: boolean): AppData =>
  ({ dir: 'x', check: async () => (ok ? { ok: true, dir: 'x' } : { ok: false, problem: 'unresolved' }), ensure: async () => ({ ok: true, dir: 'x' }) }) as unknown as AppData;

describe('activity service', () => {
  it('filters by tool and decision, limits the page and reports the total and the tools', async () => {
    fake.entries = sampleAuditEntries();
    const service = createActivityService({ appData: appData(true) });
    const all = await service.list({ limit: 200 });
    expect(all.total).toBe(5);
    expect(all.tools).toEqual(['create_invoice', 'delete_invoice', 'list_invoices', 'update_invoice']);
    const page = await service.list({ limit: 1, tool: 'create_invoice' });
    expect(page.entries.map((e: AuditEntry) => e.decision)).toEqual(['approved']);
    expect(page.total).toBe(2);
    expect(page.tools).toHaveLength(4);
    const denied = await service.list({ limit: 50, decision: 'denied' });
    expect(denied.entries.map((e: AuditEntry) => e.tool)).toEqual(['delete_invoice']);
  });

  it('answers an empty list when the data folder is unusable or the read fails', async () => {
    fake.entries = sampleAuditEntries();
    expect(await createActivityService({ appData: appData(false) }).list({ limit: 50 })).toEqual({ entries: [], tools: [], total: 0 });
    fake.entries = { slice: () => { throw new Error('boom'); } } as unknown as unknown[];
    expect(await createActivityService({ appData: appData(true) }).list({ limit: 50 })).toEqual({ entries: [], tools: [], total: 0 });
  });
});
