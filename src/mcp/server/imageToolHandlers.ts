/**
 * show_images — push an image carousel to the connected PWA (non-blocking).
 */

import { childLogger } from '../../log.js';
import { pushToPhone } from '../../state/controlSocket.js';
import { ShowImagesSchema } from '../schemas.js';
import { setImages, DEFAULT_BATCH_TTL_MS } from './imageRegistry.js';

const log = childLogger('mcp:server:imageTools');

export interface ShowImagesResult {
  ok: boolean;
  count: number;
  delivered: boolean;
  batch_id?: string;
  error?: string;
}

export function handleShowImages(args: unknown): ShowImagesResult {
  const parsed = ShowImagesSchema.safeParse(args);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join('; ');
    return { ok: false, count: 0, delivered: false, error: message };
  }

  const { images, duration_ms, caption } = parsed.data;
  const durationMs = duration_ms ?? 8000;

  try {
    const { batchId, images: carouselImages } = setImages(images, DEFAULT_BATCH_TTL_MS);

    const payload = {
      type: 'show_images' as const,
      batch_id: batchId,
      images: carouselImages,
      duration_ms: durationMs,
      caption: caption ?? null,
    };

    const delivered = pushToPhone(payload);
    log.info(
      { batchId, count: carouselImages.length, delivered, durationMs },
      'show_images pushed',
    );

    return {
      ok: true,
      count: carouselImages.length,
      delivered,
      batch_id: batchId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'show_images failed');
    return { ok: false, count: 0, delivered: false, error: message };
  }
}
