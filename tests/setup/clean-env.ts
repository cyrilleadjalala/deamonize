import { isScrubbedName } from '../helpers/env-scrub';

// Runs before every test file: ambient DAEMONIZE_* secrets, model and data-dir variables must not leak in.
for (const name of Object.keys(process.env)) if (isScrubbedName(name)) delete process.env[name];
