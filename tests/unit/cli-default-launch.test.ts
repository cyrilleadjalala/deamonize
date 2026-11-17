import { describe, expect, it, vi } from 'vitest';
import { buildProgram, type CliDeps } from '../../src/cli/index.js';

function fakeDeps() {
  const handle = { close: vi.fn(async () => undefined) };
  const studio = vi.fn(async () => handle);
  const untilInterrupted = vi.fn(async () => undefined);
  return { studio, untilInterrupted, handle, deps: { studio, untilInterrupted } as unknown as CliDeps };
}

const argv = (...args: string[]): string[] => ['node', 'daemonize', ...args];

describe('default launch of the CLI', () => {
  it('bare daemonize starts the Studio like `studio --open`', async () => {
    const { deps, studio, untilInterrupted, handle } = fakeDeps();
    await buildProgram(deps).parseAsync(argv());
    expect(studio).toHaveBeenCalledTimes(1);
    expect(studio).toHaveBeenCalledWith('daemonize-out', {
      workflows: 'daemonize.workflows.json',
      host: '127.0.0.1',
      allowRemote: false,
      open: true,
      sample: false,
    });
    expect(untilInterrupted).toHaveBeenCalledWith(handle);
  });

  it('keeps every subcommand registered with its flags', () => {
    const program = buildProgram(fakeDeps().deps);
    const names = program.commands.map((c) => c.name());
    for (const name of ['record', 'compile', 'merge', 'serve', 'studio', 'sandbox']) expect(names).toContain(name);
    const flags = (name: string): string[] => program.commands.find((c) => c.name() === name)!.options.map((o) => o.long ?? '');
    expect(flags('record')).toEqual(expect.arrayContaining(['--label', '--out', '--storage-state', '--headless']));
    expect(flags('studio')).toEqual(expect.arrayContaining(['--workflows', '--port', '--host', '--allow-remote', '--open', '--sample']));
  });

  it('runs the studio subcommand without the default launch and without exiting', async () => {
    const { deps, studio, untilInterrupted } = fakeDeps();
    await buildProgram(deps).parseAsync(argv('studio', '--sample'));
    expect(studio).toHaveBeenCalledTimes(1);
    expect(studio).toHaveBeenCalledWith('daemonize-out', expect.objectContaining({ sample: true, open: false }));
    expect(untilInterrupted).toHaveBeenCalledWith(expect.anything(), { exit: false });
  });

  it('rejects an unknown argument naming it, without starting the Studio', async () => {
    const { deps, studio } = fakeDeps();
    await expect(buildProgram(deps).parseAsync(argv('foo'))).rejects.toThrow(/Unknown argument "foo"/);
    expect(studio).not.toHaveBeenCalled();
  });

  it('prints help for -h with exit code 0 and does not start the Studio', async () => {
    const { deps, studio } = fakeDeps();
    const program = buildProgram(deps);
    let out = '';
    program.exitOverride();
    program.configureOutput({ writeOut: (text) => { out += text; }, writeErr: () => { } });
    await expect(program.parseAsync(argv('-h'))).rejects.toMatchObject({ exitCode: 0 });
    expect(studio).not.toHaveBeenCalled();
    for (const name of ['record', 'compile', 'merge', 'serve', 'studio', 'sandbox']) expect(out).toContain(name);
  });
});
