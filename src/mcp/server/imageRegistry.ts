/**
 * Ephemeral in-memory store for image batches pushed to the PWA via show_images.
 *
 * Single active batch — a new show_images call overwrites the previous one.
 * Local paths and base64 payloads are served through GET /api/images/:id?k=KEY
 * using a per-batch ephemeral access key (img tags cannot send Bearer tokens).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { getDb } from '../../state/db.js';
import { childLogger } from '../../log.js';

const log = childLogger('mcp:server:imageRegistry');

export const MAX_IMAGES_PER_BATCH = 10;
export const MAX_BASE64_BYTES = 4 * 1024 * 1024;
export const DEFAULT_BATCH_TTL_MS = 30 * 60 * 1000;

export type ImageKind = 'path' | 'base64' | 'url';

export interface ImageInput {
  path?: string;
  url?: string;
  data?: string;
  mime?: string;
  caption?: string;
}

export interface StoredImage {
  id: string;
  kind: ImageKind;
  /** Resolved path, raw base64 bytes (not data URI), or external URL. */
  value: string;
  mime: string;
  caption?: string;
}

export interface CarouselImagePayload {
  id: string;
  src: string;
  caption?: string;
}

export interface SetImagesResult {
  batchId: string;
  accessKey: string;
  images: CarouselImagePayload[];
}

interface ActiveBatch {
  batchId: string;
  accessKey: string;
  expiresAt: number;
  images: Map<string, StoredImage>;
}

let activeBatch: ActiveBatch | null = null;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function parseDataUriOrBase64(data: string): { mime: string; base64: string } {
  const trimmed = data.trim();
  const match = /^data:([^;]+);base64,(.+)$/is.exec(trimmed);
  if (match && match[1] && match[2]) {
    return { mime: match[1], base64: match[2].replace(/\s/g, '') };
  }
  return { mime: 'image/png', base64: trimmed.replace(/\s/g, '') };
}

function estimateBase64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/** Enabled project roots + OS temp and common screenshot dirs. */
export function getAllowedPathRoots(): string[] {
  const roots: string[] = [];
  try {
    const rows = getDb()
      .prepare('SELECT path FROM project WHERE enabled = 1')
      .all() as { path: string }[];
    for (const row of rows) {
      roots.push(resolve(row.path));
    }
  } catch (err) {
    log.warn({ err }, 'could not read project paths for image allowlist');
  }

  roots.push(resolve(tmpdir()));
  roots.push(resolve(homedir(), '.cursor'));
  roots.push(resolve(process.cwd(), 'data'));

  return [...new Set(roots)];
}

/** Validate a filesystem path is under an allowed root (no traversal). */
export function resolveAllowedImagePath(filePath: string): string | null {
  const resolved = resolve(filePath);
  const roots = getAllowedPathRoots();
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + '/') || resolved.startsWith(root + '\\')) {
      if (!existsSync(resolved)) {
        return null;
      }
      return resolved;
    }
  }
  return null;
}

function isExpired(): boolean {
  return activeBatch !== null && Date.now() > activeBatch.expiresAt;
}

function clearIfExpired(): void {
  if (isExpired()) {
    activeBatch = null;
  }
}

export function clearImages(): void {
  activeBatch = null;
}

export function getActiveAccessKey(): string | null {
  clearIfExpired();
  return activeBatch?.accessKey ?? null;
}

export function getImage(id: string, accessKey: string): StoredImage | null {
  clearIfExpired();
  if (!activeBatch || activeBatch.accessKey !== accessKey) {
    return null;
  }
  return activeBatch.images.get(id) ?? null;
}

/**
 * Store a new image batch, replacing any prior batch.
 * Returns carousel payloads with src URLs ready for the PWA.
 */
export function setImages(
  items: ImageInput[],
  ttlMs = DEFAULT_BATCH_TTL_MS,
): SetImagesResult {
  if (items.length === 0) {
    throw new Error('images array must not be empty');
  }
  if (items.length > MAX_IMAGES_PER_BATCH) {
    throw new Error(`Too many images (max ${MAX_IMAGES_PER_BATCH})`);
  }

  const batchId = randomUUID();
  const accessKey = randomUUID();
  const expiresAt = Date.now() + ttlMs;
  const images = new Map<string, StoredImage>();
  const payloads: CarouselImagePayload[] = [];

  for (const item of items) {
    const id = randomUUID();
    let stored: StoredImage;

    if (item.path) {
      const resolved = resolveAllowedImagePath(item.path);
      if (!resolved) {
        throw new Error(`Image path not allowed or missing: ${item.path}`);
      }
      stored = {
        id,
        kind: 'path',
        value: resolved,
        mime: item.mime ?? mimeFromPath(resolved),
        caption: item.caption,
      };
      payloads.push({
        id,
        src: `/api/images/${id}?k=${accessKey}`,
        caption: item.caption,
      });
    } else if (item.url) {
      const url = item.url.trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('url must start with http:// or https://');
      }
      stored = {
        id,
        kind: 'url',
        value: url,
        mime: item.mime ?? 'image/png',
        caption: item.caption,
      };
      payloads.push({
        id,
        src: url,
        caption: item.caption,
      });
    } else if (item.data) {
      const { mime, base64 } = parseDataUriOrBase64(item.data);
      const bytes = estimateBase64Bytes(base64);
      if (bytes > MAX_BASE64_BYTES) {
        throw new Error(`Image data exceeds ${MAX_BASE64_BYTES} bytes`);
      }
      stored = {
        id,
        kind: 'base64',
        value: base64,
        mime: item.mime ?? mime,
        caption: item.caption,
      };
      payloads.push({
        id,
        src: `/api/images/${id}?k=${accessKey}`,
        caption: item.caption,
      });
    } else {
      throw new Error('Each image must have exactly one of path, url, or data');
    }

    images.set(id, stored);
  }

  activeBatch = { batchId, accessKey, expiresAt, images };
  log.info({ batchId, count: payloads.length }, 'image batch stored');

  return { batchId, accessKey, images: payloads };
}

/** Read image bytes for serving (path/base64 only). */
export function readImageBytes(stored: StoredImage): Buffer | null {
  if (stored.kind === 'path') {
    const resolved = resolveAllowedImagePath(stored.value);
    if (!resolved) return null;
    try {
      return readFileSync(resolved);
    } catch {
      return null;
    }
  }
  if (stored.kind === 'base64') {
    try {
      return Buffer.from(stored.value, 'base64');
    } catch {
      return null;
    }
  }
  return null;
}
