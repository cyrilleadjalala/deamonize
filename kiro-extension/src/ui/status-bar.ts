import * as vscode from 'vscode';
import { statusSentence } from '../core/models/status-model';
import { S } from '../core/strings';
import type { Controller } from './controller';

/** A state item and a recording item. Also sets the context keys used by the menus. */
export function registerStatusBar(controller: Controller): vscode.Disposable[] {
  const stateItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  stateItem.command = 'daemonize.showLog';
  const recordingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  recordingItem.command = 'daemonize.finishRecording';

  let lastRecordingContext: boolean | undefined;
  const update = (): void => {
    stateItem.text = `$(shield) ${statusSentence(controller.state)}`;
    stateItem.tooltip = S.logChannel;
    stateItem.show();

    const recording = controller.recording;
    const isRecording = recording?.state === 'recording';
    if (recording && ['recording', 'saving', 'compiling'].includes(recording.state)) {
      recordingItem.text = recording.state === 'recording'
        ? `$(record) ${S.statusRecording(recording.steps)}`
        : `$(sync) ${recording.state === 'saving' ? S.recordingSaving : S.recordingBuilding}`;
      recordingItem.tooltip = S.finish;
      recordingItem.show();
    } else {
      recordingItem.hide();
    }
    if (lastRecordingContext !== isRecording) {
      lastRecordingContext = isRecording;
      void vscode.commands.executeCommand('setContext', 'daemonize.recording', isRecording);
    }
    void vscode.commands.executeCommand('setContext', 'daemonize.state', controller.state);
  };
  update();
  return [stateItem, recordingItem, controller.onDidRefresh(update) as vscode.Disposable];
}
