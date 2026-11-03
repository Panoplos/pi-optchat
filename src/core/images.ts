import type { ImageContent } from '@earendil-works/pi-ai';
import type { Store } from './store.ts';

/** How a message's image reads in memory: `[image <16 hex digits>]`, named by the host (Pi: a hash of the image as sent). */
const REF = /\[image ([0-9a-f]{16})\]/g;
const ONLY_REF = new RegExp(`^${REF.source}$`);
/** The ref that names an image in memory's text. */
export const ref = (name: string) => `[image ${name}]`;
/** The image name a text is the ref of, when it is that ref and nothing else. */
export const refName = (text: string) => ONLY_REF.exec(text)?.[1];

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

/** The image kept under `name`; none if it never was. */
export async function loadImage(store: Store, name: string): Promise<ImageContent | undefined> {
  const kept = await store.image(name);
  return kept && { type: 'image', data: base64(kept.data), mimeType: kept.mimeType };
}
/** The kept images a text refers to, with their names, in order, each once; ones never kept are skipped. */
export async function namedImages(store: Store, text: string): Promise<{ name: string; image: ImageContent }[]> {
  const names = [...new Set(Array.from(text.matchAll(REF), match => match[1]))], images = await Promise.all(names.map(name => loadImage(store, name)));
  return names.flatMap((name, k) => {
    const image = images[k];
    return image ? [{ name, image }] : [];
  });
}
/** The kept images a text refers to, in order, each once; ones never kept are skipped. */
export const loadImages = async (store: Store, text: string) => (await namedImages(store, text)).map(({ image }) => image);
