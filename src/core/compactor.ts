import type { Api, AssistantMessage, Message, Model, Models, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { COMPACT, compaction, IMPORT_GUIDANCE, tooLong } from './prompts.ts';
import { bytes, cut, NODE, Refused, type Compressor } from './memory.ts';
import { cachePayload, splitView } from './cache.ts';
import { ref } from './images.ts';

/** The longest line kept without asking again, unless the host sets its own (Pi's "Summary size tolerance"). */
export const ACCEPTED_BYTES = NODE * 1.25;
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until it answers.
 * Parallel compactions end their views at different messages, so a call also waits for a primer of a shorter prefix of its own view. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    const priming = () => { for (const [k, state] of warm) if (typeof state !== 'number' && prefix.startsWith(k)) return state; };
    for (let state = warm.get(prefix) ?? priming(); state !== undefined; state = warm.get(prefix) ?? priming()) {
      if (typeof state === 'number') { if (Date.now() - state < WARM_MS) break; warm.delete(prefix); continue; }
      // A cancelled waiter leaves at once instead of waiting for someone else's primer.
      signal.throwIfAborted();
      let wake = () => {};
      const aborted = new Promise<void>(resolve => { wake = resolve; });
      signal.addEventListener('abort', wake, { once: true });
      await Promise.race([state, aborted]);
      signal.removeEventListener('abort', wake);
      signal.throwIfAborted();
    }
    let release = () => {};
    const pending = warm.has(prefix) ? undefined : new Promise<void>(resolve => { release = resolve; });
    if (pending) warm.set(prefix, pending);
    return (ok: boolean) => {
      if (ok) { for (const [k, at] of warm) if (typeof at === 'number' && Date.now() - at >= WARM_MS) warm.delete(k); warm.set(prefix, Date.now()); }
      else if (warm.get(prefix) === pending) warm.delete(prefix);
      release();
    };
  };
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
/** Whether a failed reply is worth asking again: pi-ai's `isRetryableAssistantError`, passed in by the host. */
export type Retryable = (reply: AssistantMessage) => boolean;
/** Pi's agent loop retries a dropped connection itself; streamSimple doesn't, so a transient error is asked again before it surfaces. */
export async function retryTransient(ask: () => Promise<AssistantMessage>, onReply: (reply: AssistantMessage) => void, retryable: Retryable,
  delays: readonly number[] = [1000, 2000], signal?: AbortSignal) {
  for (let retry = 0; ; retry++) {
    const reply = await ask();
    onReply(reply);
    if (retry >= delays.length || !retryable(reply)) return reply;
    await sleep(delays[retry], signal);
  }
}

/** The compactor's model for one call, as the host resolves it: `stream` is pi-ai's `Models.streamSimple`, or Pi's
 * `ModelRegistry.streamSimple`, which has its shape. */
export interface CompactorModel { model: Model<Api>; reasoning?: SimpleStreamOptions['reasoning']; stream: Models['streamSimple'] }
export interface CompressorOptions {
  /** Resolves the model for each call, so a settings change applies to the next summary. Throws if it is unavailable. */
  model: () => CompactorModel;
  retryable: Retryable;
  onUsage?: (reply: AssistantMessage) => void;
  /** The longest line kept without a retry; ACCEPTED_BYTES unless the host has a setting for it. */
  accepted?: () => number;
  retryDelays?: readonly number[];
  /** The compactor's system prompt: COMPACT, unless the host's chat isn't one user and OptChat. */
  system?: string;
}

/** Builds summary lines with the model `model` resolves. The model is asked for 512 bytes. */
export function createCompressor({ model: resolve, retryable, onUsage = () => {}, accepted = () => ACCEPTED_BYTES, retryDelays,
  system = COMPACT }: CompressorOptions): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const { model, reasoning: thinking, stream: streamSimple } = resolve();
    // A model without image input gets none, and a short message it can't see more of stays its own line, word for word.
    const short = bytes(input.source) <= NODE;
    let images = model.input.includes('image') ? input.images : [];
    if (short && !images.length) return input.source;
    // The images go after the task, so the view stays the cached prefix its sibling compactions share; each follows its name.
    const task = (): Message => ({ role: 'user', timestamp: Date.now(), content: [
      // OpenAI joins text blocks with nothing between them, so the task starts its own paragraph after the view.
      { type: 'text', text: input.context },
      { type: 'text', text: `\n\n${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${compaction({ ...input, images })}` },
      ...images.flatMap(({ name, image }) => [{ type: 'text' as const, text: `\n${ref(name)}` }, image])] });
    let messages: Message[] = [task()];
    const view = splitView(input.context);
    const prefix = model.api === 'anthropic-messages' && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
    const tries: string[] = [];
    const ask = async () => {
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      try {
        const stream = streamSimple(model, { systemPrompt: system, messages }, {
          // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
          sessionId: 'optchat-compactor', transport: 'sse',
          reasoning: thinking, signal, cacheRetention: 'short',
          onPayload: payload => model.api === 'anthropic-messages' ? cachePayload(payload, { end: false }) : payload,
        });
        // The cache entry is usable once the model starts answering.
        for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
        return await stream.result();
      } finally { warmed(false); }
    };
    const answer = () => retryTransient(ask, onUsage, retryable, retryDelays, signal);
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await answer();
      // Any error the retry rule doesn't cover, with images sent: the images (too big, too many), which every retry would send again,
      // or not (a bad key, no quota, a dropped connection). Asked once more by name only, the second kind fails again below and the
      // summary is tried again later, images and all. It is not one of the 5 tries, so a fifth reply can't end the loop without it.
      if (images.length && reply.stopReason === 'error' && !retryable(reply)) { images = []; messages = [task()]; attempt--; continue; }
      // A stop reason means the model answered: a refusal or a content filter, which asking again repeats.
      // A provider's own 'error' stop (Mistral) is a failure on its side, not an answer: a plain error, tried again later.
      if (reply.stopReason === 'error' && reply.rawStopReason !== undefined && reply.rawStopReason !== 'error' && !retryable(reply))
        throw new Refused(reply.errorMessage ?? `Compactor stopped: ${reply.rawStopReason}`);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      // Answered by name only, so the images were the error: a short message has nothing more to say than its names.
      if (short && !images.length) return input.source;
      // A reply cut off at the token limit, or one that calls a tool, is no summary: ask again.
      if (reply.stopReason === 'length' || reply.content.some(c => c.type === 'toolCall')) continue;
      // The compactions' view shows each line under its id+n| head, which a line can copy.
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
      // Nor is one with no text at all, such as a reply that spends all its output thinking: ask again. 5 such replies are a refusal.
      if (!line) continue;
      tries.push(line);
      // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces; a line that
      // says what images show may be longer than the names it replaces.
      if (bytes(line) <= accepted() && (images.length > 0 || bytes(line) < bytes(input.source))) break;
      messages.push(reply);
      messages.push({ role: 'user', content: tooLong(bytes(line), cut(line)), timestamp: Date.now() });
    }
    if (!tries.length) throw new Refused('Compactor returned no whole line in 5 tries.');
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}
