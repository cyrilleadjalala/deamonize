/**
 * The approvals service of the Studio: heartbeat of `approver.json`, the list of pending questions and the decision.
 * G0 stub (inert, so the Studio runs as before); group G-D replaces the body and keeps the signature.
 */
import type { AppData, ApprovalsService } from './contracts.js';
import { InertApprovalsService } from './inert-services.js';

export interface ApprovalsServiceDeps {
  appData: AppData;
  now?: () => number;
}

export function createApprovalsService(_deps: ApprovalsServiceDeps): ApprovalsService {
  return new InertApprovalsService();
}
