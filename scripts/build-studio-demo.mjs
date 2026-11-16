// Builds the static Studio demo: a folder of plain files (HTML, CSS, JS, JSON, PNG) that needs no server, for
// GitHub Pages or any static host. The data comes from the built-in fictitious sample data through the same view
// builders as the live Studio; the playground is simulated in the browser by the shared `ui/js/sim` modules.
//
// Usage: node scripts/build-studio-demo.mjs [--out <dir>]      (default: dist-demo)
// Needs `npm run build` first: the view builders are imported from dist/.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiSource = join(root, 'src', 'studio', 'ui');
const distStudio = join(root, 'dist', 'studio');

function parseOut(argv) {
  const i = argv.indexOf('--out');
  if (i === -1) return resolve(root, 'dist-demo');
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error('--out needs a directory');
    process.exit(1);
  }
  return resolve(process.cwd(), value);
}
const out = parseOut(process.argv.slice(2));

// The output folder is emptied first: never one that holds the project or the folder we run in
const holds = (parent, child) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
if (holds(out, root) || holds(out, resolve(process.cwd())) || dirname(out) === out) {
  console.error('Refusing to write the demo into a folder that contains the project or the current directory.');
  process.exit(1);
}
if (!existsSync(join(uiSource, 'index.html'))) {
  console.error('Studio UI sources not found. Run this from a Daemonize checkout.');
  process.exit(1);
}
const need = (file) => {
  const path = join(distStudio, file);
  if (!existsSync(path)) {
    console.error(`dist/studio/${file} not found: run "npm run build" first.`);
    process.exit(1);
  }
  return import(pathToFileURL(path).href);
};
const model = await need('model.js');
const sampleData = await need('sample-data.js');
const samplePlayground = await need('sample-playground.js');
const { sanitizeSchema } = await need('playground.js');
const { redactForStudio } = await need('redact.js');

// ---------------------------------------------------------------------------
// Pictures: a tiny deterministic PNG encoder (RGB, stored with zlib), no dependency, no browser
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A raster of RGB pixels with a few drawing helpers. */
class Canvas {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }
  rect(x, y, w, h, [r, g, b]) {
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
        const at = (j * this.width + i) * 3;
        this.pixels[at] = r;
        this.pixels[at + 1] = g;
        this.pixels[at + 2] = b;
      }
    }
  }
  /** A rectangle outline, `dash` > 0 makes it dashed. */
  outline(x, y, w, h, color, thickness = 2, dash = 0) {
    const on = (n) => dash === 0 || Math.floor(n / dash) % 2 === 0;
    for (let n = 0; n < w; n++) if (on(n)) {
      this.rect(x + n, y, 1, thickness, color);
      this.rect(x + n, y + h - thickness, 1, thickness, color);
    }
    for (let n = 0; n < h; n++) if (on(n)) {
      this.rect(x, y + n, thickness, 1, color);
      this.rect(x + w - thickness, y + n, thickness, 1, color);
    }
  }
  png() {
    const rows = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      const at = y * (this.width * 3 + 1);
      rows[at] = 0; // filter: none
      this.pixels.copy(rows, at + 1, y * this.width * 3, (y + 1) * this.width * 3);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const C = {
  page: [24, 24, 36], bar: [44, 38, 74], panel: [36, 36, 54], row: [52, 52, 76], rowAlt: [44, 44, 66],
  dialog: [236, 232, 250], field: [200, 194, 226], button: [142, 107, 240], red: [236, 84, 96], green: [72, 200, 140], orange: [255, 162, 77],
};

/** The CRM page with the table, optionally with the "New customer" dialog open. */
function crmPage(width, height, extra) {
  const s = width / 640;
  const u = (n) => Math.round(n * s);
  const c = new Canvas(width, height, C.page);
  c.rect(0, 0, width, u(34), C.bar);
  c.rect(u(14), u(11), u(90), u(12), C.orange);
  c.rect(u(24), u(52), u(150), u(300), C.panel);
  for (let i = 0; i < 5; i++) c.rect(u(34), u(68 + i * 30), u(100), u(10), C.field);
  for (let i = 0; i < 7; i++) c.rect(u(190), u(52 + i * 36), u(430), u(30), i % 2 ? C.rowAlt : C.row);
  extra(c, u);
  return c;
}

function failurePng() {
  return crmPage(640, 360, (c, u) => {
    c.rect(u(150), u(64), u(340), u(236), C.dialog);
    c.rect(u(150), u(64), u(340), u(30), C.button);
    for (let i = 0; i < 3; i++) c.rect(u(172), u(116 + i * 44), u(296), u(24), C.field);
    // Where the Save button used to be: gone
    c.outline(u(360), u(256), u(108), u(30), C.red, Math.max(2, u(2)), u(6));
    c.outline(0, 0, u(640), u(360), C.red, Math.max(3, u(4)));
  }).png();
}

function finalPng() {
  return crmPage(640, 360, (c, u) => {
    c.rect(u(190), u(88), u(430), u(30), C.green);
    c.rect(u(206), u(98), u(160), u(10), C.dialog);
  }).png();
}

function thumbnailPng(variant) {
  return crmPage(160, 90, (c, u) => {
    c.outline(u(variant === 'chart' ? 282 : 190), u(variant === 'chart' ? 120 : 52), u(variant === 'chart' ? 60 : 430), u(variant === 'chart' ? 120 : 30), C.orange, 1);
  }).png();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const sample = sampleData.sampleStudioData();
// The same hygiene as the live server: nothing from the environment can be in the data
const targets = redactForStudio(sample.targets, { env: {}, secretValues: [] });
const stateGraph = redactForStudio(sample.stateGraph, { env: {}, secretValues: [] });

const workflows = model.buildWorkflows(targets);
const assetNames = new Set();
// A thumbnail is served as a file next to the data, not from an API route
for (const view of workflows.workflows) {
  for (const step of view.steps) {
    if (typeof step.thumbnailUrl === 'string') {
      const name = step.thumbnailUrl.slice('/api/assets/'.length);
      assetNames.add(name);
      step.thumbnailUrl = `data/assets/${name}`;
    }
  }
}

const views = workflows.workflows;
const tools = samplePlayground.sampleTools().map((tool) => {
  const view = views.find((w) => w.toolName === tool.name);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: sanitizeSchema(tool.inputSchema),
    risk: view?.risk.highest ?? 'write',
    levels: view === undefined ? [] : [...new Set(view.steps.map((s) => s.primaryLevel))],
    secrets: view?.secrets ?? [],
    sensitiveArgs: view === undefined ? [] : view.steps.flatMap((s) => (s.usesSecret && s.variable !== undefined ? [s.variable] : [])),
    ...(view === undefined ? {} : { label: view.label }),
  };
});

const data = {
  'overview.json': model.buildOverview(targets, true),
  'workflows.json': workflows,
  'graph.json': model.buildGraph(targets, stateGraph),
  'schemas.json': model.buildSchemas(targets),
  'pbt.json': model.buildPbtView(sample.pbt, targets, false),
  'playground-tools.json': tools,
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The UI as it is, minus the type declarations of the shared modules
cpSync(uiSource, out, { recursive: true, filter: (src) => !src.endsWith('.d.ts') });

const dataDir = join(out, 'data');
mkdirSync(join(dataDir, 'assets'), { recursive: true });
for (const [name, value] of Object.entries(data)) writeFileSync(join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
writeFileSync(join(dataDir, 'failure.png'), failurePng());
writeFileSync(join(dataDir, 'final.png'), finalPng());
for (const name of assetNames) writeFileSync(join(dataDir, 'assets', name), thumbnailPng(/chart/.test(name) ? 'chart' : 'search'));

const TITLE = 'Daemonize Studio: live demo';
const DESCRIPTION = 'Give any app a voice. Explore the workflows, replay levels, state graph and MCP tools Daemonize learned from a pretend CRM and a sqlite3 session. A simulated demo: no real application is driven.';
const CSP = "default-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const attr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const headExtra = [
  '  <meta name="daemonize-mode" content="static">',
  `  <meta http-equiv="Content-Security-Policy" content="${attr(CSP)}">`,
  `  <meta name="description" content="${attr(DESCRIPTION)}">`,
  '  <meta property="og:type" content="website">',
  `  <meta property="og:title" content="${attr(TITLE)}">`,
  `  <meta property="og:description" content="${attr(DESCRIPTION)}">`,
  '  <meta property="og:site_name" content="Daemonize">',
  '  <meta name="twitter:card" content="summary">',
  `  <meta name="twitter:title" content="${attr(TITLE)}">`,
  `  <meta name="twitter:description" content="${attr(DESCRIPTION)}">`,
].join('\n');

const indexPath = join(out, 'index.html');
let index = readFileSync(indexPath, 'utf-8');
const anchor = '<meta name="referrer" content="no-referrer">';
if (!index.includes(anchor)) throw new Error('index.html changed: the demo build cannot find where to add its meta tags');
index = index.replace(anchor, `${anchor}\n${headExtra}`).replace('<title>Daemonize Studio</title>', `<title>${attr(TITLE)}</title>`);
writeFileSync(indexPath, index);

writeFileSync(
  join(out, '404.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found · Daemonize Studio demo</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#181824;color:#ece8fa;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:32rem;padding:2rem}a{color:#d9c8ff}</style>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>This demo is a single page. <a href="./">Open the Daemonize Studio demo</a>.</p>
</main>
</body>
</html>
`
);
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(
  join(out, 'README.txt'),
  `Daemonize Studio: static demo
=============================

This folder is a complete website made of plain files. It needs no server, no build step and no network access
other than the one that serves these files.

- index.html     the Studio single-page app (hash routes, relative URLs: it works under any sub-path)
- data/*.json    the fictitious sample data (a pretend CRM and a sqlite3 session)
- data/*.png     pictures drawn by the build for the simulated playground
- .nojekyll      tells GitHub Pages to serve the files as they are

The playground is a SIMULATION that runs in the page: no real application is driven, and nothing is sent anywhere.

To try it locally, serve the folder with any static file server, for example:
  npx serve .
Opening index.html straight from the disk does not work: browsers block loading the data files from file: URLs.

Generated by "npm run studio:build" in the Daemonize repository. Do not edit by hand.
`
);

console.log(`Studio demo written to ${relative(process.cwd(), out) || '.'} (${Object.keys(data).length} data files)`);
