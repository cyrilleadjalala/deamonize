import { describe, it, expect } from 'vitest';
import config from '../../vitest.config';

describe('vitest config', () => {
  it('lists clean-env.ts in the fast and integration projects', () => {
    const projects = (config.test?.projects ?? []) as Array<{ test?: { name?: string; setupFiles?: string[] } }>;
    for (const name of ['fast', 'integration']) {
      const project = projects.find((p) => p.test?.name === name);
      expect(project, name).toBeDefined();
      expect(project!.test!.setupFiles ?? []).toContain('./tests/setup/clean-env.ts');
    }
  });
});
