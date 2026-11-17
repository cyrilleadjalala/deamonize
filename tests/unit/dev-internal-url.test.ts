import { describe, it, expect } from 'vitest';
import { isDevInternalUrl, isStaticUrl, isAnalyticsUrl } from '../../src/recorder/network-capture.js';

const DEV = [
  'http://localhost:3000/_next/static/webpack/abc.webpack.hot-update.json',
  'http://localhost:3000/_next/static/chunks/app/page.hot-update.js',
  'http://localhost:3000/_next/webpack-hmr',
  'http://localhost:3000/__nextjs_original-stack-frame?x=1',
  'http://localhost:3000/__webpack_hmr',
  'http://localhost:3000/base/_next/webpack-hmr',
  'http://localhost:5173/@vite/client',
  'http://localhost:5173/@react-refresh',
  'http://localhost:5173/@fs/home/x',
  'http://localhost:5173/__vite_ping',
  'http://localhost:3000/sockjs-node/info',
];

describe('isDevInternalUrl (Property 5)', () => {
  it.each(DEV)('filters %s', (url) => {
    expect(isDevInternalUrl(url)).toBe(true);
    expect(isStaticUrl(url)).toBe(true);
  });
});

describe('static and analytics filters (Property 6)', () => {
  it.each([
    'http://x/app.js',
    'http://x/a.css',
    'http://x/i.png',
    'http://x/f.woff2',
  ])('keeps filtering asset %s', (url) => expect(isStaticUrl(url)).toBe(true));

  it.each(['http://x/api/customers?q=a', 'http://x/_next/data/x/page.json', 'http://x/api/auth/login/verify'])(
    'does not filter %s',
    (url) => {
      expect(isStaticUrl(url)).toBe(false);
      expect(isDevInternalUrl(url)).toBe(false);
    },
  );

  it('analytics unchanged', () => {
    expect(isAnalyticsUrl('http://x/analytics/collect')).toBe(true);
    expect(isAnalyticsUrl('http://x/api/customers')).toBe(false);
  });
});
