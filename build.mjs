// Minify liquid-glass.js with Oxc and stamp the real download sizes into index.html.
// Both outputs are committed so Cloudflare Pages can serve the repo root as is; CI checks they are fresh.
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { minify } from 'oxc-minify';

const src = await readFile('liquid-glass.js', 'utf8');
const { code, errors } = await minify('liquid-glass.js', src, { module: true });
if (errors.length) throw new AggregateError(errors, 'oxc-minify failed');

const min = `/*! liquid-glass.js · https://liquid-glass.naa.gg */\n${code}`;
await writeFile('liquid-glass.min.js', min);

const kb = text => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;
const sizes = { min: kb(min), gzip: kb(gzipSync(min, { level: 9 })), src: kb(src) };
const html = await readFile('index.html', 'utf8');
await writeFile(
  'index.html',
  html.replace(/(data-size="(\w+)">)[^<]*/g, (_, open, k) => open + sizes[k]),
);
console.log(sizes);
