import { createHash } from 'node:crypto';
import type { ImageContent } from '@earendil-works/pi-ai';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { isImage, ref } from './core/images.ts';
import { isMime, type Store } from './core/store.ts';

/** Kept images fit 2048 px on the long side and ~1.5 MB (2 MB as base64), re-encoded as JPEG 85 only when they don't already. */
export const IMAGE_LIMITS = { maxWidth: 2048, maxHeight: 2048, maxBytes: 2 * 1024 * 1024, jpegQuality: 85 };

const hash = (image: ImageContent) => createHash('sha256').update(image.data).digest('hex').slice(0, 16);
/** How a message's image reads in memory: named by the image as the message holds it, before any shrinking, so it always gets the same name. */
export const imageRef = (image: ImageContent) => ref(hash(image));

/** Keeps each image of a message's content in the store, once per distinct image, shrunk to IMAGE_LIMITS. */
export async function saveImages(store: Store, content: unknown) {
  if (!Array.isArray(content)) return;
  for (const image of content.filter(isImage)) {
    const name = hash(image);
    if (await store.image(name)) continue;
    // Pi's own resizer (Photon, WASM), as its read tool uses: it returns small images untouched, and null if it can't decode.
    const kept = await resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, IMAGE_LIMITS) ?? image;
    if (isMime(kept.mimeType)) await store.putImage(name, kept.mimeType, Buffer.from(kept.data, 'base64'));
  }
}
