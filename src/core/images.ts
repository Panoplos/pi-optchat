import type { ImageContent } from '@earendil-works/pi-ai';
import type { Store } from './store.ts';

/** How a message's image reads in memory: `[image <16 hex digits>]`, named by the host (Pi: a hash of the image as sent). */
const REF = /\[image ([0-9a-f]{16})\]/g;

export const isImage = (part: unknown): part is ImageContent => typeof part === 'object' && part !== null
  && 'type' in part && part.type === 'image' && 'data' in part && typeof part.data === 'string' && 'mimeType' in part && typeof part.mimeType === 'string';

/** Base64 in chunks: one String.fromCharCode call per image would pass the engine's argument limit. */
const base64 = (data: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
};
/** An image's base64 as bytes. */
export const decode = (data: string) => Uint8Array.from(atob(data), char => char.charCodeAt(0));

/** The kept images a text refers to, with their names, in order, each once; ones never kept are skipped. */
export async function namedImages(store: Store, text: string): Promise<{ name: string; image: ImageContent }[]> {
  const names = [...new Set(Array.from(text.matchAll(REF), match => match[1]))], kept = await Promise.all(names.map(name => store.image(name)));
  return names.flatMap((name, k) => {
    const image = kept[k];
    return image ? [{ name, image: { type: 'image' as const, data: base64(image.data), mimeType: image.mimeType } }] : [];
  });
}
/** The kept images a text refers to, in order, each once; ones never kept are skipped. */
export const loadImages = async (store: Store, text: string) => (await namedImages(store, text)).map(({ image }) => image);
