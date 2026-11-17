/** Group G3 owns this file. Stub: an idle manager until the real one lands. */
import type { CompileRunner, RecordingManager, SessionStore } from './contracts.js';
import { InertRecordingManager } from './inert-services.js';

export interface RecordingManagerDeps {
  /** Absolute path of the Workflow_File. */
  workflowFile: string;
  sessions: SessionStore;
  compiler: CompileRunner;
  /** Removes known secret values and paths from a text. */
  scrub: (text: string) => string;
}

export class NullRecordingManager extends InertRecordingManager { }

export function createRecordingManager(_deps: RecordingManagerDeps): RecordingManager {
  return new NullRecordingManager();
}