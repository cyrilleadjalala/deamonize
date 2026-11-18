import * as vscode from 'vscode';
import { createRecordingPoller } from '../../core/recording-poller';
import type { RecordingPoller } from '../../core/ports';
import { S } from '../../core/strings';
import { validateName, validateUrl, type Validation } from '../../core/validate';
import type { Controller } from '../controller';

interface Pick { label: string; reuse: boolean }

async function askField(
  prompt: string,
  placeHolder: string,
  validate: (input: unknown) => Validation<string>,
  value?: string,
  note?: string,
): Promise<string | undefined> {
  const typed = await vscode.window.showInputBox({
    prompt: note ? `${note} ${prompt}` : prompt,
    placeHolder,
    value,
    ignoreFocusOut: true,
    validateInput: (text) => {
      const result = validate(text);
      return result.ok ? undefined : result.message;
    },
  });
  if (typed === undefined) return undefined;
  const checked = validate(typed);
  return checked.ok ? checked.value : undefined;
}

export function registerRecordCommands(controller: Controller): vscode.Disposable[] {
  let poller: RecordingPoller | undefined;

  const ensurePoller = (): RecordingPoller => {
    if (poller) return poller;
    poller = createRecordingPoller({
      fetchStatus: async () =>
        (await controller.query((api) => api.recordStatus())) ?? { ok: false as const, status: 0, error: S.networkError },
      onStatus: (status) => controller.setRecording(status),
      onFinished: (status) => {
        controller.setRecording(undefined);
        if (status.state === 'done') {
          void vscode.window.showInformationMessage(S.recordingSaved(controller.lastActionName ?? ''));
        } else if (status.state === 'error') {
          void vscode.window.showErrorMessage(S.recordingFailed(controller.redact(status.error ?? '')));
        }
        controller.refresh();
      },
      onGaveUp: () => {
        controller.setRecording(undefined);
        void vscode.window.showErrorMessage(S.recordingGaveUp, S.restart).then((choice) => {
          if (choice === S.restart) void vscode.commands.executeCommand('daemonize.restart');
        });
      },
      setTimeout,
      clearTimeout,
    });
    return poller;
  };

  const newAction = vscode.commands.registerCommand('daemonize.newAction', async () => {
    if (!(await controller.ensureFolder())) return;

    let name = await askField(S.namePrompt, S.namePlaceholder, validateName);
    if (name === undefined) return;
    let url = await askField(S.urlPrompt, S.urlPlaceholder, validateUrl);
    if (url === undefined) return;
    const pick = await vscode.window.showQuickPick<Pick>(
      [{ label: S.reuseYes, reuse: true }, { label: S.reuseNo, reuse: false }],
      { placeHolder: S.reuseSessionPick, ignoreFocusOut: true },
    );
    if (pick === undefined) return;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await controller.withStudio((api) => api.recordStart({ name: name!, url: url!, reuseSession: pick.reuse }));
      if (answer === undefined) return;
      if (answer.ok) {
        controller.lastActionName = name;
        controller.setRecording({ state: 'recording', steps: 0, labels: [] });
        void vscode.window.showInformationMessage(S.recordingStarted);
        ensurePoller().start();
        return;
      }
      const reason = controller.redact(answer.error || S.recordingNoLongerStarts);
      if (answer.field === 'name') {
        if (answer.status === 409) {
          void vscode.window.showErrorMessage(S.recordingFailed(reason));
          return;
        }
        const fixed = await askField(S.namePrompt, S.namePlaceholder, validateName, name, reason);
        if (fixed === undefined) return;
        name = fixed;
      } else if (answer.field === 'url') {
        if (answer.status === 409) {
          void vscode.window.showErrorMessage(S.recordingFailed(reason));
          return;
        }
        const fixed = await askField(S.urlPrompt, S.urlPlaceholder, validateUrl, url, reason);
        if (fixed === undefined) return;
        url = fixed;
      } else if (answer.status === 409 && /already in progress|already being created/i.test(reason)) {
        void vscode.window.showErrorMessage(S.recordingAlready);
        return;
      } else {
        void vscode.window.showErrorMessage(S.recordingFailed(reason));
        return;
      }
    }
    void vscode.window.showErrorMessage(S.recordingFailed(S.recordingNoLongerStarts));
  });

  const finish = vscode.commands.registerCommand('daemonize.finishRecording', async () => {
    const answer = await controller.withStudio((api) => api.recordStop());
    if (answer === undefined) return;
    if (!answer.ok) {
      void vscode.window.showErrorMessage(answer.status === 409 ? S.recordingNone : controller.redact(answer.error || S.recordingNone));
      return;
    }
    controller.setRecording({ state: 'saving', steps: controller.recording?.steps ?? 0, labels: controller.recording?.labels ?? [] });
    ensurePoller().start();
  });

  return [newAction, finish, { dispose: () => poller?.stop() }];
}
