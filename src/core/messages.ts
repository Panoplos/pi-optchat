import type { ImageContent, Message, TextContent, UserMessage } from '@earendil-works/pi-ai';
import { CAP, cap, type Kind, type Memory } from './memory.ts';
import { isImage, refName } from './images.ts';

/** A turn's messages as core reads them: pi-ai's, plus a host's own (Pi's custom messages), which pass through untouched. */
export type AnyMessage = Message | { role: string; timestamp: number; content?: string | (TextContent | ImageContent)[] };
const is = <R extends Message['role']>(message: AnyMessage, role: R): message is Extract<Message, { role: R }> => message.role === role;
/** Names an image in memory's text, as `[image <16 hex digits>]` (see loadImages). */
export type ImageRef = (image: ImageContent) => string;

/** A message's text; `imageRef` names each image in it, or images are left out. */
export function textContent(content: unknown, imageRef?: ImageRef): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null) return '';
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
    if (imageRef && isImage(part)) return imageRef(part);
    return '';
  }).filter(Boolean).join('\n');
}
/** A message as the recipe's kinds: a user message as `kind` (`user`, or `work` for a subagent's report), a reply's text as `talk`,
 * its tool calls as `tool`, tool results and a failed reply as `echo`. Other roles say nothing. */
export function said(message: AnyMessage, { kind = 'user', imageRef }: { kind?: Kind; imageRef?: ImageRef } = {}) {
  const lines: [Kind, string][] = [];
  if (is(message, 'user')) lines.push([kind, textContent(message.content, imageRef)]);
  else if (is(message, 'assistant')) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) lines.push(['talk', block.text]);
      if (block.type === 'toolCall') lines.push(['tool', `${block.name} ${JSON.stringify(block.arguments)}`]);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      lines.push(['echo', `Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`]);
  } else if (is(message, 'toolResult'))
    // A zoom's page already names the images it returns.
    lines.push(['echo', cap(`${message.toolName}: ${textContent(message.content, message.toolName !== 'zoom' ? imageRef : undefined)}`)]);
  return lines;
}
/** Logs what a message `said`, each with `receipt`. */
export function logMessage(memory: Memory, message: AnyMessage, { kind, receipt, imageRef }: { kind?: Kind; receipt?: string; imageRef?: ImageRef } = {}) {
  const date = new Date(message.timestamp).toISOString();
  for (const [k, text] of said(message, { kind, imageRef })) memory.append(k, text, date, receipt);
}
/** Ends a child conversation's first input, before its task. */
export const TASK_HEADER = '\n\nYour task:\n';
/** A child conversation's first input: the view, then optionally the exchange before the run and the run so far as `kind: text`
 * lines (each image as `[image]`), then its task. With the view and task alone, it is what Pi's subagents get. */
export function childInput({ view, previous = [], run = [], task }: { view: string; previous?: readonly AnyMessage[]; run?: readonly AnyMessage[]; task: string }) {
  const part = (title: string, messages: readonly AnyMessage[]) => {
    const lines = messages.flatMap(m => said(m, { imageRef: () => '[image]' })).map(([kind, text]) => `${kind}: ${text}`);
    return lines.length ? [`${title}:\n${lines.join('\n')}`] : [];
  };
  return `${[view, ...part('The exchange before this run', previous), ...part('This run so far', run)].join('\n\n')}${TASK_HEADER}${task}`;
}
/** A text block that is only an image's ref, which a host may send in the image's place until the request is built (durable). */
const isRef = (block: TextContent | ImageContent) => block.type === 'text' && refName(block.text) !== undefined;
/** A tool result over CAP keeps its head and tail, and its images and their refs. */
export function boundedMessage<M extends AnyMessage>(message: M): M {
  if (!is(message, 'toolResult')) return message;
  const text = message.content.flatMap(c => c.type === 'text' && !isRef(c) ? [c.text] : []).join('\n');
  if (text.length <= CAP) return message;
  return { ...message, content: [{ type: 'text', text: cap(text) }, ...message.content.filter(c => c.type === 'image' || isRef(c))] };
}
/** The view goes before the first user message's words, in that message, so everything up to them is one cached prefix. */
export function withView<M extends AnyMessage>(messages: readonly M[], view: string): (M | UserMessage)[] {
  let injected = false;
  return messages.map(message => {
    if (!is(message, 'user') || injected) return message;
    injected = true;
    // OpenAI joins text blocks with nothing between them, so the user's words start their own paragraph after the view.
    const [first, ...rest] = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    return { ...message, content: [{ type: 'text' as const, text: view }, ...first?.type === 'text' ? [{ ...first, text: `\n\n${first.text}` }] : first ? [first] : [], ...rest] };
  });
}
/** A settled run's requests and its final text answer, for the previous exchange; none unless it ended in one. The caller supplies
 * a single settled run, including any steering after text-only replies. */
export function completedExchange(history: readonly AnyMessage[], imageRef?: ImageRef): Message[] {
  const last = history.findLastIndex(m => m.role === 'user' || m.role === 'assistant');
  const answer = history[last];
  if (!answer || !is(answer, 'assistant') || answer.stopReason !== 'stop'
    || answer.content.some(block => block.type === 'toolCall')) return [];
  const content = answer.content.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []);
  if (!content.some(block => block.text.trim())) return [];
  const requests: UserMessage[] = [];
  for (const message of history.slice(0, last)) if (is(message, 'user')) requests.push({ ...message, content: textContent(message.content, imageRef) });
  if (!requests.length) return [];
  return [...requests, { ...answer, content }];
}

/** Pi's own estimate for an image when it decides to compact: 4,800 characters, about 1,200 tokens. */
const IMAGE_CHARS = 4_800;
/** Characters a message adds to a request: its text, thinking, tool-call arguments and images (an image's ref too), as Pi estimates
 * them. Framing is left out. */
export function messageChars({ content = [] }: AnyMessage) {
  if (typeof content === 'string') return content.length;
  let sum = 0;
  for (const block of content) sum += block.type === 'text' ? refName(block.text) === undefined ? block.text.length : IMAGE_CHARS : block.type === 'thinking' ? block.thinking.length
    : block.type === 'toolCall' ? JSON.stringify(block.arguments).length : block.type === 'image' ? IMAGE_CHARS : 0;
  return sum;
}
/** The share of the model's window a turn's verbatim messages may fill (#146) in characters, at ~4 characters a token; none when
 * off or the window is unknown. */
export function refreshBudget(contextWindow: number | undefined, fraction: number) {
  return contextWindow && fraction > 0 ? Math.floor(contextWindow * fraction * 4) : undefined;
}
const chars = (messages: readonly AnyMessage[]) => messages.reduce((sum, m) => sum + messageChars(m), 0);
/** Where a refresh would cut the run: the last model reply, so its tool calls and their results stay whole. 0 when there is none after the task. */
export function lastStep(run: readonly AnyMessage[]) {
  const task = run.findIndex(m => m.role === 'user'), step = run.findLastIndex(m => m.role === 'assistant');
  return step > task && task >= 0 ? step : 0;
}
/** The run's new `keep` and the size it moves into the view, when what is sent since the last refresh passes the budget.
 * What stays verbatim (the task and the last step) must fit in half the budget: a bigger last step, such as many parallel
 * reads, would otherwise pass the budget again on the next call and refresh every call. It waits for a smaller step instead. */
export function refreshPoint(run: readonly AnyMessage[], keep: number, budget: number | undefined) {
  const cut = lastStep(run), task = run.find(m => m.role === 'user');
  if (!budget || cut <= keep) return undefined;
  const size = chars(run.slice(keep));
  if (size <= budget || (task ? messageChars(task) : 0) + chars(run.slice(cut)) > budget / 2) return undefined;
  return { cut, size };
}
/** The run as sent after a mid-turn refresh at `keep`: the task verbatim, then the run from `keep` on. Everything between is in the view. */
export function refreshedRun<M extends AnyMessage>(run: readonly M[], keep: number, note: string): (M | UserMessage)[] {
  const task = run.find(m => m.role === 'user');
  if (!keep || !task || !is(task, 'user')) return [...run];
  const content = typeof task.content === 'string' ? [{ type: 'text' as const, text: task.content }] : task.content;
  return [{ ...task, content: [...content, { type: 'text' as const, text: `\n\n${note}` }] }, ...run.slice(keep)];
}
