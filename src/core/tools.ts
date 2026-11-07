import { Type, type Static } from 'typebox';
import { flat, head, PAGE, start, type Memory } from './memory.ts';
import { loadImages } from './images.ts';
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export const SEARCH_PAGE = 20;
const SNIPPET = 200;

/** One page of hits, each with its id, the view line holding it, its date and a snippet around the first match; at most ~5 KB. */
export function searchPage(memory: Memory, text: string, before?: number) {
  const hits = memory.search(text, before), older = before === undefined ? '' : 'older ';
  if (!hits.length) return `No ${older}messages contain "${text}".`;
  const page = hits.slice(0, SEARCH_PAGE), needle = text.toLowerCase();
  const lines = page.map(entry => {
    // Cut the original text, whose match may span lines, and flatten only the cut.
    const text = memory.text(entry.i), at = Math.max(0, text.toLowerCase().indexOf(needle) - SNIPPET / 4);
    const snippet = flat(text.slice(at, at + SNIPPET).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, ''));
    // The live view, which may have folded since the turn's snapshot: its lines are built, so zoom always opens them.
    const line = memory.covering(entry.i); // Named only when the hit is inside a summary line.
    return `${entry.i}${line?.l ? ` (in ${start(line)}+${2 ** line.l})` : ''} · ${new Date(entry.date).toString().slice(0, 21)} · ${head(entry)}: ${at ? '…' : ''}${snippet}${at + SNIPPET < text.length ? '…' : ''}`;
  });
  const more = hits.length > page.length ? `\nOlder matches: search again with before: ${page[page.length - 1].i}.` : '';
  return `${hits.length} ${older}${hits.length === 1 ? 'message contains' : 'messages contain'} "${text}", newest first:\n${lines.join('\n')}${more}`;
}

const zoomParameters = Type.Object({ id: Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1 })]), n: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE })) });

/** A page of a run's transcript, saying where the next one starts. */
export function runPage(text: string, offset = 0, limit = PAGE) {
  if (offset > text.length) throw new Error(`This transcript has ${text.length} characters; offset must be 0 to ${text.length}.`);
  // Never split a surrogate pair: a page starts on its first half and ends after its second.
  const from = /[\udc00-\udfff]/.test(text[offset] ?? '') ? offset - 1 : offset;
  let to = Math.min(text.length, from + limit);
  if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to += to - 1 === from ? 1 : -1;
  return `${text.slice(from, to)}\n[characters ${from}-${to} of ${text.length}${to < text.length ? `; go on with offset ${to}` : ''}]`;
}

/** `runs`, for a host with subagents, gives one's transcript by run id, live or finished, as the host writes it; undefined for
 * no such run. Without it, zoom says nothing of runs. */
export function memoryTools(memory: () => Memory, runs?: (id: string) => string | undefined) {
  return [
    { name: 'zoom', label: 'Zoom memory', description: `Open the line id+n of the view into the two lines of n/2 under it; n = 1 (the default) gives the message whole. A message over ${PAGE.toLocaleString('en-US')} characters comes in pages; offset and limit (characters) read any part of it, and are not needed for a shorter one. A message's images come back with it.${runs ? ' zoom("<run id>") gives a subagent\'s whole chat so far, in the same pages.' : ''}`,
      parameters: zoomParameters,
      async execute(_id: string, { id, n = 1, offset, limit }: Static<typeof zoomParameters>) {
        if (typeof id === 'string') {
          const transcript = runs?.(id);
          if (transcript !== undefined) return result(runPage(transcript, offset, limit));
          // A model may quote a message id; eight digits can be a run id (Pi's are eight hex digits), so those never open a message.
          if (!/^\d+$/.test(id) || (runs && id.length === 8)) throw new Error(runs ? `No run ${id}.` : `No message ${id}.`);
        }
        const m = memory(), text = m.zoom(Number(id), n, offset, limit), page = result(text);
        // A message's images come back with its text, as read returns a PNG; summaries stay text.
        return n === 1 ? { ...page, content: [...page.content, ...await loadImages(m.store, text)] } : page;
      } },
    { name: 'date', label: 'Memory date', description: 'The date and time of message id.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
      async execute(_id: string, args: { id: number }) { return result(memory().date(args.id)); } },
  ] as const;
}

export const searchTool = (memory: () => Memory) => ({ name: 'search', label: 'Search memory',
  description: `Find the original messages that contain text (plain text, any case), newest first, ${SEARCH_PAGE} at a time; before: id continues with older ones. zoom(id, 1) gives a hit whole.`,
  parameters: Type.Object({ text: Type.String({ minLength: 1 }), before: Type.Optional(Type.Integer({ minimum: 0 })) }),
  async execute(_id: string, args: { text: string; before?: number }) { return result(searchPage(memory(), args.text, args.before)); } });
