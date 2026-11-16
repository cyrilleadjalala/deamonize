// A scripted healer for the integration tests, loaded by the generated server through DAEMONIZE_HEALER_MODULE
// (honoured only when NODE_ENV=test). It picks the first mark whose name contains DAEMONIZE_FAKE_HEALER_TARGET and
// appends one line per call to DAEMONIZE_FAKE_HEALER_LOG, so the test can count the calls of a separate process.
import { appendFileSync } from 'node:fs';

export function createHealer(env) {
  return {
    async locate(req) {
      if (env.DAEMONIZE_FAKE_HEALER_LOG) {
        const line = { intent: req.intent, marks: req.marks.length, thumbnailBytes: req.anchorThumbnailPng ? req.anchorThumbnailPng.length : 0 };
        appendFileSync(env.DAEMONIZE_FAKE_HEALER_LOG, JSON.stringify(line) + '\n');
      }
      const target = env.DAEMONIZE_FAKE_HEALER_TARGET ?? '';
      const mark = req.marks.find((m) => m.name && m.name.includes(target));
      return mark ? { kind: 'mark', markId: mark.id } : { kind: 'none', reason: 'fake healer: no mark named ' + target };
    },
  };
}
