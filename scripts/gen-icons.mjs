#!/usr/bin/env node
/**
 * Generate PNG icons from web/public/icon.svg.
 *
 * Requires: npm install --save-dev sharp
 * Run:      node scripts/gen-icons.mjs
 * Output:   web/public/icon-192.png
 *            web/public/icon-512.png
 *
 * These are committed to the repo so the PWA works without running the script
 * every build. Re-run only when the SVG changes.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const svgPath = resolve(root, 'web/public/icon.svg');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error(
    'sharp is not installed. Run: npm install --save-dev sharp\n' +
      'Then: node scripts/gen-icons.mjs',
  );
  process.exit(1);
}

const svgBuffer = readFileSync(svgPath);

const sizes = [
  { size: 192, out: resolve(root, 'web/public/icon-192.png') },
  { size: 512, out: resolve(root, 'web/public/icon-512.png') },
];

for (const { size, out } of sizes) {
  await sharp(svgBuffer).resize(size, size).png().toFile(out);
  console.log(`✓ ${out}`);
}

console.log('Icons generated.');
