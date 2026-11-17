/** Group G3 owns this file. Stub: an inert store until the real one lands. */
import type { AppData, SessionStore } from './contracts.js';
import { InertSessionStore } from './inert-services.js';

export interface SessionStoreDeps {
  appData: AppData;
}

export class NullSessionStore extends InertSessionStore { }

export function createSessionStore(_deps: SessionStoreDeps): SessionStore {
  return new NullSessionStore();
}