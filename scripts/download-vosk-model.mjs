#!/usr/bin/env node
/**
 * Download vosk-model-small-en-us (~50 MB) and pack as model.tar.gz for vosk-browser.
 * Output: web/public/vosk/model.tar.gz
 */

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = resolve(ROOT, 'web/public/vosk');
const MODEL_TAR = resolve(OUT_DIR, 'model.tar.gz');
const MODEL_ZIP_URL =
  'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const MODEL_DIR_NAME = 'vosk-model-small-en-us-0.15';

function log(msg) {
  console.log(`[vosk-model] ${msg}`);
}

async function download(url, dest) {
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status})`);
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return;
  } catch (err) {
    log(`fetch failed (${err instanceof Error ? err.message : err}) — trying curl…`);
  }

  execFileSync('curl', ['-fsSL', url, '-o', dest], { stdio: 'inherit' });
}

function unzip(zipPath, destDir) {
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' });
}

function tarGz(sourceDir, destTar) {
  execFileSync('tar', ['-czf', destTar, '-C', resolve(sourceDir, '..'), MODEL_DIR_NAME], {
    stdio: 'inherit',
  });
}

async function main() {
  if (existsSync(MODEL_TAR)) {
    log(`Already present: ${MODEL_TAR}`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const workDir = resolve(OUT_DIR, '.download');
  const zipPath = resolve(workDir, 'model.zip');
  mkdirSync(workDir, { recursive: true });

  try {
    log(`Downloading ${MODEL_ZIP_URL}`);
    await download(MODEL_ZIP_URL, zipPath);
    log('Extracting…');
    unzip(zipPath, workDir);
    log('Packing model.tar.gz…');
    tarGz(resolve(workDir, MODEL_DIR_NAME), MODEL_TAR);
    log(`Done — ${MODEL_TAR}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[vosk-model] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
