import { describe, expect, it } from 'vitest';
import { KiroPowerGenerator } from '../../src/compiler/kiro-power-generator';

const set = {
  targetType: 'web',
  targetName: 'My Shop',
  startUrl: 'https://shop.example',
  workflows: [
    {
      id: 'w1',
      name: 'login',
      steps: [{ actionType: 'type', secretRef: 'PASSWORD' }],
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
} as never;
const names = new Map([['w1', 'login']]);
const generate = (options?: { powerName?: string }) => new KiroPowerGenerator().generate(set, names, '/out', options);

describe('KiroPowerGenerator naming and wording', () => {
  it('uses powerName for the plugin name, server key, skill name and POWER.md', () => {
    const power = generate({ powerName: 'shop-example' });
    expect(power.plugin.name).toBe('shop-example');
    expect(Object.keys(power.mcp.mcpServers)).toEqual(['shop-example']);
    expect(power.skill).toContain('name: shop-example');
    expect(power.powerMd).toContain('skills/shop-example/SKILL.md');
  });

  it('keeps the kebab-case target name without powerName (CLI output)', () => {
    const power = generate();
    expect(power.plugin.name).toBe('my-shop');
    expect(Object.keys(power.mcp.mcpServers)).toEqual(['my-shop']);
    expect(JSON.stringify(power)).toBe(JSON.stringify(generate({})));
  });

  it('states that the password comes from the vault, with names only', () => {
    const { skill } = generate({ powerName: 'shop-example' });
    expect(skill).toContain('Daemonize vault');
    expect(skill).toContain('Credentials');
    expect(skill).toContain('`DAEMONIZE_SECRET_PASSWORD`');
    expect(skill).not.toContain('must be set for the server');
  });
});
