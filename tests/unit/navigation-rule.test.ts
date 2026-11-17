import { describe, expect, it } from 'vitest';
import {
  dropNavigationReads,
  isScreenNavigation,
  navigationReason,
  routeKey,
} from '../../src/recorder/navigation-rule.js';

const att = (method: string, path: string, bound: string[] = []) => ({
  request: { method, url: `https://app.test${path}` },
  recipe: { method },
  bound,
});

describe('routeKey', () => {
  it('removes the trailing slash, query and hash', () => {
    expect(routeKey('https://a.test/x/?q=1#h')).toBe('https://a.test/x');
    expect(routeKey('https://a.test/')).toBe('https://a.test');
  });
  it('ignores default ports', () => {
    expect(routeKey('https://a.test:443/x')).toBe('https://a.test/x');
    expect(routeKey('http://a.test:80/x')).toBe('http://a.test/x');
    expect(routeKey('http://a.test:3000/x')).toBe('http://a.test:3000/x');
  });
  it('returns undefined for an invalid URL', () => {
    expect(routeKey('not a url')).toBeUndefined();
    expect(routeKey('')).toBeUndefined();
  });
});

describe('isScreenNavigation', () => {
  const nav = { from: 'https://a.test/home', to: 'https://a.test/merchants' };
  it('is true for a click that changes the route', () => {
    expect(isScreenNavigation({ actionType: 'click', submit: false, nav })).toBe(true);
  });
  it('is false for a submit', () => {
    expect(isScreenNavigation({ actionType: 'click', submit: true, nav })).toBe(false);
  });
  it('is false for the same route, even with another query or trailing slash', () => {
    expect(isScreenNavigation({ actionType: 'click', submit: false, nav: { from: 'https://a.test/s', to: 'https://a.test/s/?q=x' } })).toBe(false);
  });
  it('is false for other actions and a missing nav', () => {
    expect(isScreenNavigation({ actionType: 'type', submit: false, nav })).toBe(false);
    expect(isScreenNavigation({ actionType: 'click', submit: false })).toBe(false);
  });
  it('is false when a URL cannot be parsed', () => {
    expect(isScreenNavigation({ actionType: 'click', submit: false, nav: { from: 'x', to: 'https://a.test/y' } })).toBe(false);
  });
});

describe('dropNavigationReads', () => {
  const list = [att('GET', '/api/a'), att('POST', '/api/b'), att('HEAD', '/api/c', ['q']), att('PUT', '/api/d')];

  it('drops reads and keeps writes in order for a screen navigation', () => {
    const { kept, dropped } = dropNavigationReads(list, { screenNavigation: true, used: [] });
    expect(kept.map((a) => a.request.method)).toEqual(['POST', 'PUT']);
    expect(dropped.map((a) => a.request.method)).toEqual(['GET', 'HEAD']);
  });
  it('returns the input unchanged when not a screen navigation or a variable is used', () => {
    for (const input of [{ screenNavigation: false, used: [] }, { screenNavigation: true, used: ['q'] }]) {
      const { kept, dropped } = dropNavigationReads(list, input);
      expect(kept).toEqual(list);
      expect(dropped).toEqual([]);
    }
  });
});

describe('navigationReason', () => {
  it('names the dropped read', () => {
    expect(navigationReason([att('GET', '/api/merchants/audience?x=1')])).toBe(
      'screen navigation: GET /api/merchants/audience is a mount request of the new screen, not an action',
    );
  });
});
