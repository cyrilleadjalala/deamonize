// Stops the stack and removes containers, networks and volumes. Usage: node down.mjs [project]
import { pathToFileURL } from 'node:url';
import { compose, PROJECT } from './up.mjs';

export function down(project = PROJECT) {
  const r = compose(['down', '-v', '--remove-orphans', '--timeout', '3'], {
    COMPOSE_PROJECT_NAME: project,
    ADMINER_PORT: '8080',
  });
  return r.status === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(down(process.argv[2]) ? 0 : 1);
}
