/** Group G4 owns this file. Stub: an idle runner until the real one lands. */
import type { CompileRunner } from './contracts.js';
import { InertCompileRunner } from './inert-services.js';
import type { PlaygroundSession } from './playground.js';

export interface CompileRunnerDeps {
  /** Absolute paths. */
  workflowFile: string;
  outDir: string;
  /** The playground is created after the services: read it lazily. */
  playground: () => PlaygroundSession | undefined;
  /** Removes known secret values and paths from a text. */
  scrub: (text: string) => string;
  /** Folders to replace with <folder> in messages (cwd, home, temp, App_Data_Dir ...). */
  paths: string[];
}

export class NullCompileRunner extends InertCompileRunner { }

export function createCompileRunner(_deps: CompileRunnerDeps): CompileRunner {
  return new NullCompileRunner();
}