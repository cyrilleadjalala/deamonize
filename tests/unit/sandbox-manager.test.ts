import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// A stand-in for dockerode: the real one needs a running Docker daemon
const createContainer = vi.fn();
vi.mock('dockerode', () => ({
  default: class FakeDocker {
    createContainer = createContainer;
  },
}));

import { SandboxManager } from '../../src/sandbox/sandbox-manager.js';
import type { DaemonizeConfig } from '../../src/types.js';

function config(memoryMb: number, cpuCount: number): DaemonizeConfig {
  return {
    targetType: 'web',
    targetUrl: 'http://localhost/',
    outputDir: 'out',
    targetName: 'App',
    sandbox: { memoryMb, cpuCount },
    replayTimeoutMs: 10000,
    snapshotIntervalMs: 100,
  };
}

/** A container whose exit the test decides. */
function fakeContainer() {
  let exit: (data: { StatusCode: number }) => void = () => {};
  const container = {
    start: vi.fn(async () => {}),
    wait: vi.fn(() => new Promise<{ StatusCode: number }>((resolve) => (exit = resolve))),
    inspect: vi.fn(async () => ({ Id: 'container-1' })),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  return { container, exitWith: (code: number) => exit({ StatusCode: code }) };
}

describe('SandboxManager', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createContainer.mockReset();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => stderr.mockRestore());

  it('creates the container with the default limits and no network', async () => {
    const { container } = fakeContainer();
    createContainer.mockResolvedValue(container);

    const id = await new SandboxManager(config(512, 1)).startContainer('image', ['run']);

    expect(id).toBe('container-1');
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: 'image',
        Cmd: ['run'],
        HostConfig: expect.objectContaining({
          Memory: 512 * 1024 * 1024,
          NanoCpus: 1e9,
          NetworkMode: 'none',
        }),
      })
    );
  });

  it('applies configured memory and CPU limits', async () => {
    createContainer.mockResolvedValue(fakeContainer().container);

    await new SandboxManager(config(256, 2)).startContainer('image', []);

    const { HostConfig } = createContainer.mock.calls[0][0];
    expect(HostConfig.Memory).toBe(256 * 1024 * 1024);
    expect(HostConfig.NanoCpus).toBe(2e9);
  });

  it('reports an exit it did not ask for, with its exit code, and logs it', async () => {
    const { container, exitWith } = fakeContainer();
    createContainer.mockResolvedValue(container);
    const manager = new SandboxManager(config(512, 1));
    const onExit = vi.fn();
    manager.onUnexpectedExit.on('exit', onExit);

    await manager.startContainer('image', []);
    exitWith(137);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onExit).toHaveBeenCalledWith({ exitCode: 137 });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('exited unexpectedly with code 137'));
  });

  it('logs the exit code whenever the container stops, not only when it stops quickly', async () => {
    const { container, exitWith } = fakeContainer();
    createContainer.mockResolvedValue(container);
    const manager = new SandboxManager(config(512, 1));
    manager.onUnexpectedExit.on('exit', () => {});

    await manager.startContainer('image', []);
    await new Promise((resolve) => setTimeout(resolve, 100));
    exitWith(1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('code 1'));
  });

  it('does not report the exit that follows a stop requested by the caller', async () => {
    const { container, exitWith } = fakeContainer();
    createContainer.mockResolvedValue(container);
    const manager = new SandboxManager(config(512, 1));
    const onExit = vi.fn();
    manager.onUnexpectedExit.on('exit', onExit);

    await manager.startContainer('image', []);
    await manager.stopContainer();
    exitWith(143);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(container.stop).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('forwards the exit of a registered driver', () => {
    const manager = new SandboxManager(config(512, 1));
    const driver = { onUnexpectedExit: new EventEmitter() };
    const onExit = vi.fn();
    manager.onUnexpectedExit.on('exit', onExit);

    manager.registerDriver(driver as never);
    driver.onUnexpectedExit.emit('exit', { exitCode: 2 });

    expect(onExit).toHaveBeenCalledWith({ exitCode: 2 });
    expect(manager.getDriver()).toBe(driver);
  });

  it('refuses to hand out a driver that was never registered', () => {
    expect(() => new SandboxManager(config(512, 1)).getDriver()).toThrow(/No driver registered/);
  });
});
