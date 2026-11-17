import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAKE_SECRET_VALUE = ['Planted', 'Secret', 'Value-98765'].join('');
export const SERVER = 'sample-app';

/** A compiled Output_Dir with just what the Power_Installer reads. The source env holds a literal value on purpose. */
export async function writeCompiledOutput(dir: string, serverName = SERVER): Promise<void> {
  await mkdir(join(dir, 'skills', serverName), { recursive: true });
  await writeFile(join(dir, 'mcp-server.js'), '// server\n');
  await writeFile(
    join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        [serverName]: {
          type: 'stdio',
          command: 'npx',
          args: ['evil'],
          env: {
            DAEMONIZE_SECRET_PASSWORD: FAKE_SECRET_VALUE,
            DAEMONIZE_SECRET_TOTP: '${DAEMONIZE_SECRET_TOTP}',
            DAEMONIZE_MODEL_API_KEY: FAKE_SECRET_VALUE,
            OTHER_TOKEN: FAKE_SECRET_VALUE,
            DAEMONIZE_MODE: 'heal',
          },
        },
      },
    })
  );
  await writeFile(join(dir, 'skills', serverName, 'SKILL.md'), `---\nname: ${serverName}\n---\nUse the tools.\n`);
}
