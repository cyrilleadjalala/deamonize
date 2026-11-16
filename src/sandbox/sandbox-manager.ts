import Docker from 'dockerode';
import { EventEmitter } from 'node:events';
import type { DaemonizeConfig } from '../types.js';
import type { SandboxDriver } from './driver.js';

export class SandboxManager {
  private docker: Docker;
  private container: Docker.Container | null = null;
  private driver: SandboxDriver | null = null;
  private stopping = false;
  readonly onUnexpectedExit = new EventEmitter();

  constructor(private config: DaemonizeConfig) {
    this.docker = new Docker();
  }

  /**
   * Create and start a Docker container with the configured resource limits.
   * Returns the container ID.
   */
  async startContainer(image: string, cmd: string[]): Promise<string> {
    const container = await this.docker.createContainer({
      Image: image,
      Cmd: cmd,
      HostConfig: {
        Memory: this.config.sandbox.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(this.config.sandbox.cpuCount * 1e9),
        NetworkMode: 'none',
        AutoRemove: false,
      },
    });

    this.container = container;
    this.stopping = false;

    await container.start();

    // Monitor the container for exit. An exit we did not ask for is logged with
    // its exit code and reported at once, so the user is told right away.
    container.wait().then((data: { StatusCode: number }) => {
      if (this.stopping) {
        return;
      }
      process.stderr.write(`[SandboxManager] Container exited unexpectedly with code ${data.StatusCode}\n`);
      this.onUnexpectedExit.emit('exit', { exitCode: data.StatusCode });
    }).catch((err: unknown) => {
      // Ignore errors from wait() — they typically mean we called stop() ourselves.
      void err;
    });

    const inspectInfo = await container.inspect();
    return inspectInfo.Id;
  }

  /**
   * Stop and remove the container if running.
   */
  async stopContainer(): Promise<void> {
    if (this.container === null) {
      return;
    }
    const container = this.container;
    this.container = null;
    this.stopping = true;
    try {
      await container.stop();
    } catch {
      // If the container is already stopped, stop() throws — ignore.
    }
    try {
      await container.remove();
    } catch {
      // Best-effort removal.
    }
  }

  /**
   * Register a SandboxDriver implementation (PlaywrightDriver or PtyDriver).
   * Monitors the container for unexpected exit and emits onUnexpectedExit.
   */
  registerDriver(driver: SandboxDriver): void {
    this.driver = driver;
    // Forward unexpected exit events from the driver to this manager's emitter.
    driver.onUnexpectedExit.on('exit', (event: { exitCode: number }) => {
      this.onUnexpectedExit.emit('exit', event);
    });
  }

  /**
   * Get the registered driver (throws if not registered).
   */
  getDriver(): SandboxDriver {
    if (this.driver === null) {
      throw new Error('No driver registered');
    }
    return this.driver;
  }
}
