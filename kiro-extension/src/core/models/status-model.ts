import { S } from '../strings';
import type { ProcessState } from '../types';

export function statusSentence(state: ProcessState): string {
  switch (state) {
    case 'starting':
      return S.statusStarting;
    case 'running':
      return S.statusRunning;
    case 'crashed':
      return S.statusCrashed;
    default:
      return S.statusStopped;
  }
}
