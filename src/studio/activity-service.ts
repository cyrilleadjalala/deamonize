/**
 * The activity service of the Studio: reads the Audit_Log through `readAuditEntries`.
 * G0 stub (inert, so the Studio runs as before); group G-D replaces the body and keeps the signature.
 */
import type { ActivityService, AppData } from './contracts.js';
import { InertActivityService } from './inert-services.js';

export interface ActivityServiceDeps {
  appData: AppData;
}

export function createActivityService(_deps: ActivityServiceDeps): ActivityService {
  return new InertActivityService();
}
