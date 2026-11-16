import type { HealRequest, HealResult, Healer } from '../../src/heal/healer.js';

/** A scripted healer: returns the queued results in order (the last one repeats) and logs every call. */
export class FakeHealer implements Healer {
  readonly calls: HealRequest[] = [];
  private index = 0;

  constructor(private readonly script: Array<HealResult | Error> = [{ kind: 'none', reason: 'fake: nothing scripted' }]) {}

  async locate(req: HealRequest): Promise<HealResult> {
    this.calls.push(req);
    const next = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (next instanceof Error) throw next;
    return next;
  }
}
