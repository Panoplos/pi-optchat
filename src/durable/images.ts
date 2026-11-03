import type { GenerationHooks, ToolExecutionResult } from '@earendil-works/pi-durable';
import { decode, isImage, isMime, loadImage, ref, refName, type AnyMessage, type ImageContent, type ImageRef, type Store } from '../core/index.ts';

export type Message = Parameters<GenerationHooks['beforeRequest']>[0]['messages'][number];
type Block = NonNullable<ToolExecutionResult['output']>[number];
type Text = Extract<Block, { type: 'text' }>;
const encoder = new TextEncoder();

/** A text block that is only an image's ref: what an image kept in memory's store leaves in Pi's transcript. */
const isRef = (block: Block): block is Text => block.type === 'text' && refName(block.text) !== undefined;

/** The images memory names, as Pi keeps them: a user's and a tool's, but not zoom's, which are kept already. */
export const keptImages = (message: AnyMessage) => message.role === 'user' || message.role === 'toolResult' && !('toolName' in message && message.toolName === 'zoom')
  ? Array.isArray(message.content) ? message.content.filter(isImage) : [] : [];
/** A zoom's page names the images it returns already, so memory leaves out the refs its images leave behind. */
export const dropZoomRefs = (m: Message) => m.role === 'toolResult' && m.toolName === 'zoom' ? { ...m, content: m.content.filter(block => !isRef(block)) } : m;

/** Each distinct image, named as Pi's OptChat names it: the first 16 hex digits of the SHA-256 of its base64; and the ImageRef that
 * names them. Web Crypto is asynchronous and core's ImageRef is not, so images are named before core reads the names. */
export async function imageNames(images: readonly ImageContent[]) {
  const distinct = [...new Map(images.map(image => [image.data, image])).values()];
  const named = await Promise.all(distinct.map(async image => {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(image.data)), 0, 8);
    return { image, name: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') };
  }));
  const names = new Map(named.map(({ image, name }) => [image.data, name]));
  const imageRef: ImageRef = image => {
    const name = names.get(image.data);
    if (name === undefined) throw new Error('OptChat was asked to name an image it was not given.');
    return ref(name);
  };
  return { named, imageRef };
}

/** Puts an image in the store; false, and logged, when the store refuses it or its type. */
export async function keep(store: Store, image: ImageContent, name: string) {
  if (!isMime(image.mimeType)) return false;
  try {
    await store.putImage(name, image.mimeType, decode(image.data));
    return true;
  } catch (error) {
    console.error(`OptChat could not keep an image: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** `content` with each image the store keeps replaced by its ref; one it refuses stays. Zoom's images are put again too: the store
 * gives them back as canonical base64, whose name differs from the stored one when the image came in otherwise. */
export async function offload(store: Store, content: readonly Block[]): Promise<Block[]> {
  const { named, imageRef } = await imageNames(content.filter(isImage));
  const kept = await Promise.all(named.map(async ({ image, name }) => await keep(store, image, name) ? [image.data] : []));
  const offloaded = new Set(kept.flat());
  return content.map(block => isImage(block) && offloaded.has(block.data) ? { type: 'text', text: imageRef(block) } : block);
}

/** Pi Durable's default bound on a tool result's text, its DEFAULT_MAX_BYTES and DEFAULT_MAX_LINES, which it doesn't export. A
 * result over the tool's bound keeps one of its text blocks, so its refs would go. A hook can't see a tool's own `outputLimits`. */
const BOUND = { bytes: 50 * 1024, lines: 2_000 };
const REF_BYTES = ref('0'.repeat(16)).length;
/** Whether a tool result's text stays inside Pi Durable's default bound once its images are refs. Pi joins its text blocks with
 * nothing between them, and a ref has no newline. */
export function fitsBound(output: readonly Block[]) {
  const text = output.map(block => block.type === 'text' ? block.text : '').join('');
  return encoder.encode(text).length + output.filter(isImage).length * REF_BYTES <= BOUND.bytes && text.split('\n').length <= BOUND.lines;
}

/** `messages` with each ref in a user message or tool result replaced by its image from the store, each read once. A ref the
 * store lacks or can't read stays as it is. */
export async function restore(store: Store, messages: readonly Message[]) {
  const reads = new Map<string, Promise<Block>>();
  const read = (name: string, block: Text) => {
    const pending = reads.get(name);
    if (pending) return pending;
    const image = loadImage(store, name).then(found => found ?? block, error => {
      console.error(`OptChat could not read an image: ${error instanceof Error ? error.message : String(error)}`);
      return block;
    });
    reads.set(name, image);
    return image;
  };
  return Promise.all(messages.map(async m => {
    if ((m.role !== 'user' && m.role !== 'toolResult') || typeof m.content === 'string') return m;
    return { ...m, content: await Promise.all(m.content.map(block => {
      if (block.type !== 'text') return block;
      const name = refName(block.text);
      return name === undefined ? block : read(name, block);
    })) };
  }));
}
