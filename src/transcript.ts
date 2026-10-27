import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, type SystemMessage } from '@earendil-works/pi-ai';
import { cap, flat, isView, type Memory } from './core/memory.ts';
import { completedExchange, logMessage as log, messageChars, TASK_HEADER, textContent as text, withView } from './core/messages.ts';
import { AT_WORK } from './core/prompts.ts';
import { record } from './core/cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { imageRef } from './images.ts';

export const RUN_BOUNDARY = 'optchat.run';
/** Subagent traffic to the main agent: a custom message on screen, a plain user message to the model, `work` in memory. */
export const REPORT_TYPE = 'optchat-report';
export const REPORT_RECEIPT = 'report:';
/** A report's receipt in memory: it marks the entry as `work` and keeps a restart from delivering the report twice. */
export const reportReceipt = (text: string) => REPORT_RECEIPT + createHash('sha256').update(text).digest('hex');

/** A message's text, its images named by `imageRef` unless `images` is false. */
export const textContent = (content: unknown, images = true) => text(content, images ? imageRef : undefined);
/** What the user typed, as Pi's input event (and so the inbox) saw it: no image references, and without the
 * `[Image …]` notes Pi appends after the text when it resizes, converts or omits an attached image. */
export function typedText(content: unknown) {
  const text = textContent(content, false);
  return { text, bare: text.replace(/\n\n\[Image[ :][^\n]*\](?:\n\[Image[ :][^\n]*\])*$/, '') };
}
/** Pi's convertToLlm sends every custom message to the model as a user message. One that is shown, or that starts the run
 * (`input`, shown or hidden), is part of the chat, so it becomes a user message here too; another extension's starts with
 * "[customType] ", as the recipe marks background work, so the compactor never takes it for the user's words. Any other hidden
 * one (display false), such as context an extension injects each turn, stays custom: the model still sees it, and memory and
 * the replay leave it out. Reports reach the model and the previous-exchange replay as user messages; memory logs them as `work`. */
export function asUser(message: AgentMessage, input = false): AgentMessage {
  if (message.role !== 'custom' || !message.display && !input) return message;
  const { content, customType, timestamp } = message;
  if (customType === REPORT_TYPE) return { role: 'user', content, timestamp };
  const tag = `[${customType}] `;
  if (typeof content === 'string') return { role: 'user', content: tag + content, timestamp };
  const [first, ...rest] = content;
  if (first?.type === 'text') return { role: 'user', content: [{ ...first, text: tag + first.text }, ...rest], timestamp };
  return { role: 'user', content: [{ type: 'text', text: tag.trimEnd() }, ...content], timestamp };
}
/** Logs a message to memory; a user message with a report's receipt as `work`. */
export const logMessage = (memory: Memory, message: AgentMessage, receipt?: string) =>
  log(memory, message, { kind: receipt?.startsWith(REPORT_RECEIPT) ? 'work' : 'user', receipt, imageRef });

/** Default limit in bytes of text (16 KB, ~4,000 tokens). Most exchanges are 1-7 KB; a larger one, usually a big paste, is
 * left out entirely and the model falls back to its summaries in the memory view, zooming for the full text if it needs it. */
export const PREVIOUS_EXCHANGE = DEFAULT_SETTINGS.previousExchangeKB * 1000;

/** The latest successful run on this branch, skipping failed and unfinished runs; none if it is over `limit` bytes. */
export function previousExchange(branch: readonly SessionEntry[], limit = PREVIOUS_EXCHANGE) {
  const exchange = latestExchange(branch);
  const bytes = exchange.reduce((sum, message) => sum + Buffer.byteLength(textContent(message.content)), 0);
  return bytes <= limit ? exchange : [];
}

function latestExchange(branch: readonly SessionEntry[]) {
  let end = -1;
  let legacyEnd = branch.length;
  // A run's first message is its input, a hidden custom one too: Pi puts it before any context it or other extensions inject.
  const messages = (entries: readonly SessionEntry[], run = false) => entries.flatMap(entry => {
    const message: AgentMessage | undefined = entry.type === 'message' ? entry.message : entry.type === 'custom_message'
      ? { role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp) } : undefined;
    if (!message) return [];
    const input = run; if (message.role !== 'system') run = false;
    return [asUser(message, input)];
  });
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== RUN_BOUNDARY || !record(entry.data)) continue;
    legacyEnd = i;
    if (entry.data.state === 'end') end = i;
    else if (entry.data.state === 'start') {
      if (end >= 0) {
        const exchange = completedExchange(messages(branch.slice(i + 1, end), true), imageRef);
        if (exchange.length) return exchange;
      }
      end = -1;
    }
  }
  // Older sessions have no run markers. Recover a successful exchange best-effort;
  // text-only steering boundaries cannot be reconstructed for those old runs.
  const legacy = messages(branch.slice(0, legacyEnd));
  let boundary = 0;
  let latest: ReturnType<typeof completedExchange> = [];
  for (let i = 0; i < legacy.length; i++) {
    const message = legacy[i];
    if (message.role !== 'assistant' || message.stopReason === 'toolUse') continue;
    const exchange = completedExchange(legacy.slice(boundary, i + 1), imageRef);
    if (exchange.length) latest = exchange;
    boundary = i + 1;
  }
  return latest;
}

/** Ends every subagent report, so the parent knows it can check the report against what the child did. */
export const fullChat = (id: string) => `Full chat: zoom("${id}")`;
export const withoutFullChat = (text: string) => text.replace(/\n\nFull chat: zoom\("[\w-]+"\)$/gm, '');
const TASK = `\n</chat>${TASK_HEADER}`;
/** Tool calls and results in a run transcript keep their head and tail, so a page holds many steps. */
const STEP = 1_000;
/** A subagent's chat for zoom, as `kind|text` lines: its task without the memory view, replies, tool calls and results, and what it was told. */
export function runTranscript(messages: readonly AgentMessage[]) {
  const task = messages.find(message => message.role === 'user');
  return messages.flatMap(message => {
    if (message.role === 'user') {
      // Only the task prompt holds the memory view: core's childInput({ view, task }) (src/agents.ts), the view, TASK_HEADER and the task.
      const text = textContent(message.content, false), at = text.indexOf(TASK);
      return [`user|${message === task && isView(text) && at >= 0 ? text.slice(at + '\n</chat>\n\n'.length) : text}`];
    }
    if (message.role === 'toolResult') return [`echo|${cap(`${message.toolName}: ${textContent(message.content, false)}`, STEP)}`];
    if (message.role !== 'assistant') return [];
    return [...message.content.flatMap(block => block.type === 'text' && block.text.trim() ? [`talk|${block.text}`]
      : block.type === 'toolCall' ? [`tool|${cap(`${block.name} ${JSON.stringify(block.arguments)}`, STEP)}`] : []),
    ...message.stopReason === 'error' || message.stopReason === 'aborted' ? [`echo|Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`] : []];
  }).join('\n');
}

/** The status line naming running agents by id and the first words of their title or task; none while nothing runs. */
export function atWork(runs: readonly { id: string; task: string; title?: string }[]) {
  if (!runs.length) return undefined;
  return AT_WORK + runs.map(({ id, task, title }) => {
    const words = flat(title ?? task).replaceAll('"', "'").split(/\s+/).filter(Boolean), start = words.slice(0, 6).join(' ');
    // Six words, but never more than 60 characters: a task can be one long word.
    const preview = [...start].slice(0, 60).join('');
    return `${id} "${preview}${words.length > 6 || preview.length < start.length ? '…' : ''}"`;
  }).join(', ') + '.';
}

/** Keep one completed exchange plus the current run; all other history comes from the view.
 * `status` goes last, after everything cached, so it never moves the cached prefix (see cachePayload). It comes with new input only
 * (the user, a report, a restart note): a call that follows a tool result is the same turn, which already had it. */
export function buildContext(canonical: AgentMessage[], run: AgentMessage[], view: string, prompt: string,
  previous: readonly AgentMessage[] = [], status?: string): AgentMessage[] {
  const system = getCurrentSystemMessage(canonical);
  const head: SystemMessage = { role: 'system', content: prompt, toolsAdded: system?.toolsAdded, timestamp: 0 };
  if (!run.some(m => m.role === 'user')) throw new Error('OptChat has no current user message; refusing to send historical context.');
  const messages = withView([...previous, ...run].filter(m => m.role !== 'system'), view);
  return [head, ...messages, ...status && messages.at(-1)?.role !== 'toolResult' ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: status }], timestamp: 0 }] : []];
}

/** The share of the model's window the current turn's verbatim messages may fill before they move into memory (#146): the
 * profile's Turn refresh threshold, unless `OPTCHAT_REFRESH_AT` gives one (0 turns it off). */
export function refreshFraction(setting: number, env = process.env.OPTCHAT_REFRESH_AT) {
  const override = env?.trim() ? Number(env) : NaN;
  return Number.isFinite(override) ? override : setting;
}

/** How full the turn's verbatim tail is of its refresh budget, as the footer shows it: at 100% the next step moves into memory. */
export function turnUsage(run: readonly AgentMessage[], keep: number, budget: number | undefined) {
  if (!budget) return undefined;
  const contextWindow = Math.floor(budget / 4), tokens = Math.floor(run.slice(keep).reduce((sum, m) => sum + messageChars(m), 0) / 4);
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}
