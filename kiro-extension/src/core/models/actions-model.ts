import { S } from '../strings';
import type { ApiResult, ProcessState, RecordingStatus, Risk, TreeNode, WorkflowRow } from '../types';

export interface FolderInfo { status: 'ok' | 'none' | 'not-local' | 'several' }

const RISK_TEXT: Record<Risk, string> = { read: S.riskRead, write: S.riskWrite, delete: S.riskDelete };
const ACTIVE = new Set(['recording', 'saving', 'compiling']);

/** Rows of the Actions view. Only `id`, `label`, `toolName` and the risk of a workflow reach a node. */
export function actionsTree(input: {
  state: ProcessState;
  folder: FolderInfo;
  workflows: ApiResult<WorkflowRow[]> | undefined;
  recording?: RecordingStatus;
}): TreeNode[] {
  if (input.folder.status === 'none') {
    return [{ id: 'info:no-folder', label: S.noFolder, icon: 'folder', command: { id: 'vscode.openFolder' } }];
  }
  if (input.folder.status === 'not-local') return [{ id: 'info:not-local', label: S.folderNotLocal, icon: 'warning' }];

  const nodes: TreeNode[] = [];
  if (input.recording !== undefined && ACTIVE.has(input.recording.state)) {
    nodes.push({
      id: 'recording',
      label: S.statusRecording(input.recording.steps),
      icon: 'sync',
      command: { id: 'daemonize.finishRecording' },
    });
  }

  if (input.state === 'stopped') {
    nodes.push({ id: 'state:stopped', label: S.statusStopped, description: S.start, icon: 'play', command: { id: 'daemonize.start' } });
    return nodes;
  }
  if (input.state === 'starting') {
    nodes.push({ id: 'state:starting', label: S.statusStarting, icon: 'sync' });
    return nodes;
  }
  if (input.state === 'crashed') {
    nodes.push({ id: 'state:crashed', label: S.statusCrashed, description: S.restart, icon: 'warning', command: { id: 'daemonize.restart' } });
    return nodes;
  }

  const result = input.workflows;
  if (result === undefined) {
    nodes.push({ id: 'info:start-to-see', label: S.startToSee, icon: 'info' });
    return nodes;
  }
  if (!result.ok) {
    nodes.push({ id: 'info:load-failed', label: S.loadFailed, description: S.tryAgain, icon: 'warning', command: { id: 'daemonize.refresh' } });
    return nodes;
  }
  if (result.data.length === 0) {
    nodes.push({ id: 'info:no-actions', label: S.noActions, icon: 'add', command: { id: 'daemonize.newAction' } });
    return nodes;
  }
  for (const w of result.data) {
    nodes.push({
      id: `action:${w.id}`,
      label: w.label,
      description: RISK_TEXT[w.risk],
      tooltip: `${w.toolName ?? S.notConnectedYet}\n${S.connectsWholeApplication}`,
      icon: w.risk,
      contextValue: 'action',
    });
  }
  return nodes;
}
