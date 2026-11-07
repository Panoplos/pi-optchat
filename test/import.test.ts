import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { crc32, deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Memory } from '../src/memory.ts';
import { bytes, openMemory, type Compressor, type Entry, type Summary } from '../src/core/memory.ts';
import type { Store } from '../src/core/store.ts';
import type { Memory as CoreMemory } from '../src/core/memory.ts';
import { localDay } from '../src/store.ts';
import { withNotes, scanLocal, scanChatGPT, scanClaudeMemories, readConversation, timestamp, type Conversation, type ImportedEntry } from '../src/import/sources.ts';
import { prepareImport, runImport, memoryDirectory, pendingImport, discardImport, deduplicate } from '../src/import/job.ts';
import { chronological, planImport, runImport as runCore } from '../src/core/import.ts';
import { chooseImport, showProgress } from '../src/import/ui.ts';
import { removeDir } from './support.ts';

const date = '2026-01-02T12:00:00.000Z';
const short: Compressor = async () => 'Historical decision summarized';
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-import-test-'));
const lines = (path: string, items: unknown[]) => writeFileSync(path, items.map(i => JSON.stringify(i)).join('\n') + '\n');
const conversation = (source: Conversation['source'], file: string): Conversation => ({ source, file, id: 'conversation-1', title: 'Fixture', project: '/synthetic', date, size: 100 });
const entry = (id: string, at = date, text = `Imported ${id}`): ImportedEntry => ({ kind: 'user', text, date: at,
  receipt: `import:${id}`, origin: { source: 'claude', conversation: id, message: id, title: id } });

test('Claude imports user messages and final replies, omitting tool loops and replayed context', async () => {
  const dir = temp(), file = join(dir, 'claude.jsonl');
  const user = { type: 'user', uuid: 'u', timestamp: date, message: { role: 'user', content: 'exact user question' } };
  lines(file, [user, user,
    { type: 'assistant', uuid: 'a', timestamp: date, message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'SECRET REASONING' }, { type: 'text', text: 'intermediate explanation' },
      { type: 'tool_use', name: 'Bash', id: 'call-1', input: { command: 'ls' } },
    ] } },
    { type: 'user', uuid: 't', timestamp: date, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result'.repeat(10_000) }] } },
    { type: 'user', uuid: 'replay', isCompactSummary: true, message: { role: 'user', content: 'REPLAYED CONTEXT' } },
    { type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'AUTOMATIC INSTRUCTIONS' } },
    { type: 'assistant', uuid: 'final', timestamp: date, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'final answer' }] } },
  ]);
  try {
    const parsed = await readConversation(conversation('claude', file));
    assert.deepEqual(parsed.entries.map(e => e.kind), ['user', 'talk']);
    assert.match(parsed.entries[1].text, /final answer/);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /SECRET REASONING|intermediate explanation|call-1|REPLAYED CONTEXT|AUTOMATIC INSTRUCTIONS/);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.entries[0].date, date);
    const renamed = await readConversation({ ...conversation('claude', file), title: 'Renamed', project: '/moved' });
    assert.deepEqual(renamed.entries.map(e => e.receipt), parsed.entries.map(e => e.receipt));
  } finally { removeDir(dir); }
});

test('Claude slash and shell commands stay as typed, with or without arguments, and their local output is dropped', async () => {
  const dir = temp(), file = join(dir, 'claude.jsonl');
  const user = (uuid: string, content: string) => ({ type: 'user', uuid, cwd: '/synthetic', timestamp: date, message: { role: 'user', content } });
  const reply = (uuid: string, text: string) => ({ type: 'assistant', uuid, timestamp: date, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  const raw = '<command-message>oreo-mode</command-message>\n<command-name>/oreo-mode</command-name>\n<command-args>ship the parser fix</command-args>';
  lines(file, [
    user('compact', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'),
    user('stdout', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
    user('stderr', '<local-command-stderr>Unknown command</local-command-stderr>'),
    user('shell', '<bash-input>git status</bash-input>'),
    user('shell-out', '<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>'),
    user('skill', raw),
    reply('a1', 'shipped'),
    user('plain', 'what is next?'),
    reply('a2', 'the docs'),
  ]);
  try {
    const parsed = await readConversation(conversation('claude', file));
    assert.deepEqual(parsed.entries.map(e => e.text), ['/compact', '!git status', '/oreo-mode ship the parser fix', 'shipped', 'what is next?', 'the docs']);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /command-|bash-|Compacted|Unknown command|On branch/);
    assert.equal(parsed.entries[2].receipt, `import:${createHash('sha256').update(JSON.stringify(['claude', 'conversation-1', 'skill', 'user', raw])).digest('hex')}`, 'the receipt still hashes the raw text');
    const scan = await scanLocal('claude', [dir]);
    assert.equal(scan.conversations[0].title, '/compact', 'the title is the command as typed, not its markup');
  } finally { removeDir(dir); }
});

test('Codex imports user messages and final answers once, excluding commentary, tools and agent traffic', async () => {
  const dir = temp(), file = join(dir, 'codex.jsonl');
  const row = (payload: unknown) => ({ type: 'response_item', timestamp: date, payload });
  lines(file, [
    row({ type: 'message', id: 'u', role: 'user', content: [{ type: 'input_text', text: 'QUESTION' }] }),
    { type: 'event_msg', payload: { type: 'user_message', message: 'QUESTION' } },
    row({ type: 'reasoning', summary: [{ text: 'SECRET' }] }),
    row({ type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'SECRET' }] }),
    row({ type: 'message', role: 'assistant', channel: 'commentary', content: [{ type: 'output_text', text: 'Progress update' }] }),
    row({ type: 'function_call', call_id: 'call1', name: 'exec', arguments: '{"cmd":"ls"}' }),
    row({ type: 'function_call_output', call_id: 'call1', output: 'files' }),
    row({ type: 'custom_tool_call', call_id: 'call2', name: 'patch', input: '+new text' }),
    row({ type: 'custom_tool_call_output', call_id: 'call2', output: [{ type: 'input_text', text: 'done' }] }),
    row({ type: 'agent_message', author: 'child', recipient: 'parent', content: 'Agent chatter' }),
    row({ type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'ANSWER' }] }),
    row({ type: 'future_type' }),
  ]);
  try {
    const parsed = await readConversation(conversation('codex', file));
    assert.deepEqual(parsed.entries.map(e => e.kind), ['user', 'talk']);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /SECRET|Progress update|Agent chatter|call1|call2/);
    assert.match(parsed.entries[1].text, /ANSWER/);
    assert.equal(parsed.warnings.length, 1);
    assert.equal(new Set(parsed.entries.map(e => e.receipt)).size, 2);
  } finally { removeDir(dir); }
});

const codexFixture = fileURLToPath(new URL('./fixtures/codex-rollout.jsonl', import.meta.url));
const receipt = (...identity: unknown[]) => `import:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;

test('Codex titles and entries skip the context Codex injects, and keep what the user typed, even in Codex\'s tag shapes', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'rollout-2026-03-04T09-00-00.jsonl'), readFileSync(codexFixture));
  try {
    const scan = await scanLocal('codex', [dir]);
    assert.equal(scan.conversations.length, 1);
    const [c] = scan.conversations;
    assert.deepEqual({ id: c.id, project: c.project, title: c.title, date: c.date },
      { id: '0199c0de-1111-7222-8333-444455556666', project: '/home/dev/synthetic-app', title: 'Add a --dry-run flag to the sync command.', date: '2026-03-04T09:00:02.000Z' });
    const parsed = await readConversation(c);
    assert.deepEqual(parsed.entries.map(e => [e.kind, e.origin?.message, e.text]), [
      ['user', 'msg-1', 'Add a --dry-run flag to the sync command.'],
      ['talk', 'msg-2', 'Added --dry-run to sync.'],
      ['user', 'msg-3', 'Now document the flag in the README.'],
      ['talk', 'msg-4', 'Documented --dry-run in the README.'],
      ['user', 'msg-5', '<EXTERNAL_notes>my own notes</EXTERNAL_notes>'],
    ]);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /AGENTS\.md|environment_context|external_repo|user_shell_command|<skill>|hook_prompt|codex_internal_context|turn_aborted|subagent_notification|SECRET|Reading the sync/);
    assert.deepEqual(parsed.warnings, []);
    const raw = '<environment_context>\n  <cwd>/home/dev/synthetic-app</cwd>\n</environment_context>\nNow document the flag in the README.';
    assert.equal(parsed.entries[2].receipt, receipt('codex', c.id, 'msg-3', 'user', raw), 'the receipt still hashes the raw text');
    assert.equal(parsed.entries[0].receipt, receipt('codex', c.id, 'msg-1', 'user', 'Add a --dry-run flag to the sync command.'));
  } finally { removeDir(dir); }
});

test('Codex phase markers exclude commentary and commit explicit final answers immediately', async () => {
  const dir = temp(), file = join(dir, 'phases.jsonl');
  const message = (id: string, phase: string, channel?: string | null) => ({ type: 'response_item', timestamp: date,
    payload: { type: 'message', id, role: 'assistant', phase, channel, content: [{ type: 'output_text', text: id }] } });
  const complete = { type: 'event_msg', payload: { type: 'task_complete' } };
  lines(file, [
    message('progress', 'commentary'), complete,
    message('answer', 'final_answer', null),
    { type: 'response_item', payload: { type: 'function_call', name: 'read', arguments: '{}' } },
    message('more-progress', 'commentary', null), complete,
  ]);
  try {
    const parsed = await readConversation(conversation('codex', file));
    assert.deepEqual(parsed.entries.map(e => e.origin?.message), ['answer']);
    assert.deepEqual(parsed.warnings, []);
  } finally { removeDir(dir); }
});

test('legacy Claude replies survive tool loops while interrupted text and distinct repeated requests are handled correctly', async () => {
  const dir = temp(), file = join(dir, 'legacy.jsonl');
  const message = (uuid: string, role: string, content: unknown, stop_reason?: string) => ({ type: role, uuid, timestamp: date, message: { role, content, stop_reason } });
  const request = message('u1', 'user', 'Original request');
  lines(file, [request, request,
    message('progress', 'assistant', 'Checking now'),
    message('tool', 'assistant', [{ type: 'tool_use', name: 'Read', id: 'call', input: {} }]),
    message('result', 'user', [{ type: 'tool_result', tool_use_id: 'call', content: 'NOISE' }]),
    message('answer', 'assistant', 'Legacy final answer'),
    message('u2', 'user', 'yes'),
    message('partial', 'assistant', 'Unfinished reply'),
    message('interrupted', 'user', '[Request interrupted by user]'),
    message('u3', 'user', 'yes'),
    message('truncated', 'assistant', 'Truncated reply', 'max_tokens'),
  ]);
  try {
    const parsed = await readConversation(conversation('claude', file));
    assert.deepEqual(parsed.entries.map(e => e.origin?.message), ['u1', 'answer', 'u2', 'u3']);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /NOISE|Checking now|Unfinished reply|Truncated reply/);
  } finally { removeDir(dir); }
});

const claudeFixture = fileURLToPath(new URL('./fixtures/claude-transcript.jsonl', import.meta.url));

test('a current Claude Code transcript drops interrupt markers with their cut-off reply, and keeps messages typed while Claude works, once', async () => {
  const parsed = await readConversation(conversation('claude', claudeFixture));
  assert.deepEqual(parsed.entries.map(e => [e.kind, e.origin?.message]),
    [['user', 'u1'], ['user', 'u2'], ['user', 'q1'], ['user', 'u3'], ['user', 'q4'], ['talk', 'a6:0'], ['user', 'u4'], ['user', 'u5'], ['talk', 'a8:0']]);
  assert.deepEqual(parsed.entries.filter(e => e.kind === 'user').map(e => e.text),
    ['Write the deploy plan for the sync service.', 'Shorter, three steps.', 'Also skip the staging step.', 'Go on without deploying.', 'And log each step.', 'Now write the changelog.', 'Mention the API change.']);
  assert.equal(parsed.entries[2].date, '2026-03-04T09:00:07.000Z');
  assert.doesNotMatch(JSON.stringify(parsed.entries), /Request interrupted|step 1 of 12|task-notification|teammate-message/);
  assert.deepEqual(parsed.warnings, []);
});

test('legacy Codex replies are superseded by later work and discarded on interruption', async () => {
  const dir = temp(), file = join(dir, 'legacy.jsonl');
  const message = (id: string, role: string, content: string, channel?: string) => ({ type: 'response_item', timestamp: date, payload: { type: 'message', id, role, content, channel } });
  lines(file, [message('u1', 'user', 'Original request'), message('a1', 'assistant', 'Legacy answer'),
    message('u2', 'user', 'Next request'), message('progress', 'assistant', 'Checking'),
    { type: 'response_item', payload: { type: 'function_call', name: 'read', arguments: '{}' } },
    message('a2', 'assistant', 'Answer after tools'), { type: 'event_msg', payload: { type: 'task_complete' } },
    message('u3', 'user', 'Unfinished request'), message('partial', 'assistant', 'Unfinished answer'),
    { type: 'event_msg', payload: { type: 'turn_aborted' } },
  ]);
  try {
    const parsed = await readConversation(conversation('codex', file));
    assert.deepEqual(parsed.entries.map(e => e.origin?.message), ['u1', 'a1', 'u2', 'a2', 'u3']);
  } finally { removeDir(dir); }
});

test('Codex discovery and parsing exclude delegated sessions while keeping user forks', async () => {
  const dir = temp();
  const child = join(dir, 'child.jsonl'), parent = join(dir, 'parent.jsonl');
  const metadata = (source: unknown) => ({ type: 'session_meta', payload: { id: 'session', cwd: '/project', source, forked_from_id: 'earlier-session' } });
  const request = { type: 'response_item', payload: { type: 'message', id: 'u', role: 'user', content: 'Request' } };
  lines(parent, [metadata('cli'), request]);
  lines(child, [metadata({ subagent: { thread_spawn: { parent_thread_id: 'session' } } }), request]);
  try {
    const scan = await scanLocal('codex', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    assert.equal((await readConversation(conversation('codex', child))).entries.length, 0);
    assert.equal((await readConversation(scan.conversations[0])).entries.length, 1);
  } finally { removeDir(dir); }
});

/** Pi and OMP session entries: one id/parentId tree, written in file order. */
const piSession = (file: string, header: Record<string, unknown>, entries: Record<string, unknown>[]) => {
  let parentId: string | null = null;
  lines(file, [{ type: 'session', version: 3, timestamp: date, cwd: '/project', ...header },
    ...entries.map(e => { const entry = { parentId, timestamp: date, ...e }; parentId = String(e.id); return entry; })]);
};
const piMessage = (id: string, message: Record<string, unknown>, parentId?: string) => ({ type: 'message', id, message, ...parentId ? { parentId } : {} });
const piUser = (id: string, text: string, extra = {}) => piMessage(id, { role: 'user', attribution: 'user', content: [{ type: 'text', text }], ...extra });
const piReply = (id: string, stopReason: string, content: unknown[], parentId?: string) => piMessage(id, { role: 'assistant', stopReason, content }, parentId);

test('Pi / OMP imports what the user typed and the replies that ended a turn, and marks a rewound branch', async () => {
  const dir = temp(), file = join(dir, 'session.jsonl');
  piSession(file, { id: 'session', title: 'Fixture' }, [
    { type: 'model_change', id: 'm', model: 'anthropic/model' }, { type: 'title_change', id: 't', title: 'RENAMED' },
    piUser('u1', 'exact user question'),
    piReply('a1', 'toolUse', [{ type: 'thinking', thinking: 'SECRET REASONING' }, { type: 'text', text: 'intermediate explanation' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }]),
    piMessage('r1', { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'TOOL OUTPUT' }] }),
    piMessage('d1', { role: 'developer', attribution: 'agent', content: [{ type: 'text', text: 'RULE REMINDER' }] }),
    piUser('n1', 'AGENT NUDGE', { attribution: 'agent' }), piUser('s1', 'SYNTHETIC PROMPT', { synthetic: true }),
    piMessage('f1', { role: 'fileMention', files: [{ path: 'a.ts', content: 'MENTIONED FILE' }] }),
    { type: 'custom_message', id: 'c1', customType: 'async-result', display: true, content: 'BACKGROUND NOTICE' },
    piReply('a2', 'stop', [{ type: 'text', text: 'TEXT BEFORE A TOOL' }, { type: 'toolCall', id: 'call-2', name: 'read', arguments: {} }]),
    piReply('a3', 'stop', [{ type: 'thinking', thinking: 'SECRET REASONING' }, { type: 'text', text: 'final answer' }]),
    piMessage('b1', { role: 'bashExecution', command: 'git status', output: 'SHELL OUTPUT', exitCode: 0 }),
    piMessage('b2', { role: 'bashExecution', command: 'cat .env', output: 'PRIVATE OUTPUT', exitCode: 0, excludeFromContext: true }),
    piMessage('p1', { role: 'pythonExecution', code: 'print(1)', output: 'PYTHON OUTPUT', exitCode: 0 }),
    // OMP records a skill as its own message; Pi expands it into the user message.
    { type: 'custom_message', id: 'k1', customType: 'skill-prompt', attribution: 'user', display: true, content: 'SKILL BODY',
      details: { name: 'grill-me', path: '/skills/grill-me/SKILL.md', args: 'one question at a time', lineCount: 3 } },
    { type: 'custom_message', id: 'k3', customType: 'skill-prompt', attribution: 'user', display: true, content: 'SKILL BODY',
      details: { name: 'grill-me', path: '/skills/grill-me/SKILL.md', args: 'the plan', prompt: 'first read this, then /skill:grill-me the plan', lineCount: 3 } },
    piUser('k2', '<skill name="review" location="/skills/review/SKILL.md">\nSKILL BODY\n</skill>\n\ncheck the PR'),
    piUser('u2', 'why are you adding redis? I just wanted the refactor'),
    piReply('a4', 'aborted', [{ type: 'text', text: 'ABORTED REPLY' }]),
    // The user rewound to a3 and typed again; the branch above stays in the file.
    piUser('u3', 'do only the refactor'), piReply('a5', 'error', [{ type: 'text', text: 'FAILED REPLY' }]),
    piReply('a6', 'length', [{ type: 'text', text: 'long answer, cut off' }]),
    { type: 'compaction', id: 'x', summary: 'COMPACTION SUMMARY' },
  ]);
  // Rewire u3 onto a3, as a rewind writes it.
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  rows.find(r => r.id === 'u3').parentId = 'a3';
  lines(file, rows);
  try {
    const parsed = await readConversation(conversation('pi', file));
    assert.deepEqual(parsed.entries.map(e => [e.kind, e.text]), [
      ['user', 'exact user question'], ['talk', 'final answer'],
      ['user', '[alternate branch]\n!git status'], ['user', '[alternate branch]\n$print(1)'],
      ['user', '[alternate branch]\n/skill:grill-me one question at a time'], ['user', '[alternate branch]\nfirst read this, then /skill:grill-me the plan'],
      ['user', '[alternate branch]\n/skill:review check the PR'],
      ['user', '[alternate branch]\nwhy are you adding redis? I just wanted the refactor'],
      ['user', 'do only the refactor'], ['talk', 'long answer, cut off']]);
    assert.doesNotMatch(JSON.stringify(parsed.entries),
      /SECRET|intermediate|TOOL OUTPUT|TEXT BEFORE|REMINDER|NUDGE|SYNTHETIC|MENTIONED|BACKGROUND|OUTPUT|SKILL BODY|ABORTED|FAILED|COMPACTION|RENAMED/);
    assert.deepEqual(parsed.warnings, []);
  } finally { removeDir(dir); }
});

test('a Pi / OMP fork adds only its new messages, though it copies the earlier ones under a new session id', async () => {
  const dir = temp(), original = join(dir, 'original.jsonl'), fork = join(dir, 'fork.jsonl');
  const earlier = [piUser('u1', 'first question'), piReply('a1', 'stop', [{ type: 'text', text: 'first answer' }])];
  piSession(original, { id: 'original' }, earlier);
  piSession(fork, { id: 'fork', parentSession: original }, [...earlier, piUser('u2', 'question on the fork')]);
  try {
    const read = async (file: string, id: string) => (await readConversation({ ...conversation('pi', file), id })).entries;
    const { added, skipped } = deduplicate([], [...await read(original, 'original'), ...await read(fork, 'fork')]);
    assert.deepEqual(added.map(e => e.text), ['first question', 'first answer', 'question on the fork']);
    assert.equal(skipped, 2);
  } finally { removeDir(dir); }
});

test('Pi / OMP discovery skips sessions that ran under OptChat and the subagent logs stored beside a session', async () => {
  const root = temp(), project = join(root, '--work-alpha--'), stem = '2026-01-02T12-00-00-000Z_alpha';
  mkdirSync(join(project, stem), { recursive: true });
  const typed = (text: string, attribution = 'user') => ({ ...piUser(text, text, { attribution }), timestamp: '2026-01-02T12:05:00.000Z' });
  lines(join(project, `${stem}.jsonl`), [{ type: 'title', v: 1, title: 'Current title' }, { type: 'session', version: 3, id: 'alpha', timestamp: date, cwd: '/work/alpha', title: 'Header title' }, typed('first request')]);
  piSession(join(project, 'beta.jsonl'), { id: 'beta', cwd: '/work/beta', title: 'Header title' }, [typed('typed request')]);
  piSession(join(project, 'gamma.jsonl'), { id: 'gamma', cwd: '/work/gamma' }, [typed('reminder', 'agent'), typed('typed request')]);
  piSession(join(project, 'delta.jsonl'), { id: 'delta', cwd: '/work/delta' }, [typed('typed request'), ...Array.from({ length: 70 }, (_, i) => typed(`message ${i}`)),
    { type: 'session_info', id: 'n1', name: 'First name' }, { type: 'session_info', id: 'n2', name: 'Named in Pi' }]);
  piSession(join(project, stem, 'Scout.jsonl'), { id: 'child' }, [typed('delegated task')]);
  // OptChat binds its profile when the session starts, or later in a session that began without it.
  piSession(join(project, 'optchat.jsonl'), { id: 'optchat' }, [...Array.from({ length: 80 }, (_, i) => typed(`message ${i}`)),
    { type: 'custom', id: 'o', customType: 'optchat.profile', data: { profile: 'work' } }]);
  try {
    const scan = await scanLocal('pi', [root]);
    assert.deepEqual(scan.conversations.map(c => [c.id, c.project, c.title]).sort(), [
      ['alpha', '/work/alpha', 'Current title'], ['beta', '/work/beta', 'Header title'], ['delta', '/work/delta', 'Named in Pi'], ['gamma', '/work/gamma', 'typed request']]);
    assert.ok(scan.conversations.every(c => c.date === '2026-01-02T12:05:00.000Z'), 'the start is the first message the user typed');
    assert.match(scan.note ?? '', /^1 session ran under OptChat/);
    assert.deepEqual(scan.warnings, []);
  } finally { removeDir(root); }
});

test('ChatGPT keeps user messages and final replies on each branch with stable identities', async () => {
  const dir = temp(), file = join(dir, 'conversations-1.json');
  const exported = { id: 'chat-1', title: 'Branches', create_time: 100, update_time: 300, current_node: 'final', mapping: {
    final: { parent: 'result', message: { id: 'f', author: { role: 'assistant' }, channel: 'final', end_turn: true, create_time: null, content: { parts: ['Final answer'] } } },
    result: { parent: 'call', message: { id: 'r', author: { role: 'tool', name: 'python' }, create_time: null, content: { parts: ['42'] } } },
    alternate: { parent: 'u', message: { id: 'alt', author: { role: 'assistant' }, create_time: 220, content: { parts: ['alternate answer'] } } },
    call: { parent: 'progress', message: { id: 'c', author: { role: 'assistant' }, channel: 'analysis', recipient: 'python', create_time: 210, content: { content_type: 'code', text: 'print(42)' } } },
    progress: { parent: 'u', message: { id: 'p', author: { role: 'assistant' }, content: { parts: ['Let me check'] } } },
    reasoning: { parent: 'u', message: { id: 'secret', author: { role: 'assistant' }, channel: 'analysis', recipient: 'all', content: { parts: ['SECRET'] } } },
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 200, content: { parts: ['question'] } } },
  } };
  writeFileSync(file, JSON.stringify([exported]));
  try {
    const scan = await scanChatGPT(dir); assert.equal(scan.conversations.length, 1);
    const parsed = await readConversation(scan.conversations[0]);
    const msgs = parsed.entries.filter(e => e.origin?.message !== 'export:selected-branch');
    assert.deepEqual(msgs.map(e => e.origin?.message), ['u', 'f', 'alt']);
    assert.equal(msgs[1].kind, 'talk'); assert.equal(msgs[1].date, new Date(210_000).toISOString());
    assert.match(msgs[2].text, /alternate branch/);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /SECRET|Let me check|print\(42\)/);
    const changed = await readConversation({ ...scan.conversations[0], exported: { ...exported, current_node: 'alternate' } });
    assert.deepEqual(changed.entries.slice(0, -1).map(e => e.receipt), msgs.map(e => e.receipt));
    assert.notEqual(changed.entries.at(-1)?.receipt, parsed.entries.at(-1)?.receipt);
    const backToOriginal = await readConversation({ ...scan.conversations[0], exported: { ...exported, update_time: 400 } });
    assert.notEqual(backToOriginal.entries.at(-1)?.receipt, parsed.entries.at(-1)?.receipt);
  } finally { removeDir(dir); }
});

test('Claude discovery keeps the parent conversation and skips modern, legacy, and sidechain child logs', async () => {
  const root = temp(), dir = join(root, 'subagents', '.claude', 'projects');
  const sub = join(dir, 'session', 'subagents'); mkdirSync(sub, { recursive: true });
  const parent = join(dir, 'session.jsonl');
  const user = { type: 'user', sessionId: 'shared', cwd: '/project', timestamp: date, message: { role: 'user', content: 'Parent request' } };
  lines(parent, [user, { type: 'assistant', sessionId: 'shared', message: { role: 'assistant', content: 'Child reported useful findings.' } }]);
  for (const name of ['a', 'b']) lines(join(sub, `agent-${name}.jsonl`), [{ type: 'user', sessionId: 'shared', cwd: '/project', timestamp: date, message: { role: 'user', content: name } }]);
  lines(join(dir, 'agent-legacy.jsonl'), [user]);
  lines(join(dir, 'renamed-child.jsonl'), [{ type: 'file-history-snapshot' }, { ...user, isSidechain: true }]);
  const workflow = join(sub, 'workflows', 'wf-fixture'); mkdirSync(workflow, { recursive: true });
  lines(join(workflow, 'journal.jsonl'), [{ type: 'started', agentId: 'a' }, { type: 'result', result: 'workflow metadata' }]);
  lines(join(workflow, 'conversation.jsonl'), [user]);
  try {
    const scan = await scanLocal('claude', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.id), ['shared']);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    assert.ok(scan.conversations.every(c => c.project === '/project' && c.date === date));
    const parsed = await readConversation(scan.conversations[0]);
    assert.equal(parsed.entries.length, 2);
    assert.match(parsed.entries[1].text, /Child reported useful findings/);
    assert.deepEqual(scan.warnings, []);
    await assert.rejects(scanLocal('claude', [dir], AbortSignal.abort()));
  } finally { removeDir(root); }
});

test('a resumed Claude session adds only its new messages, also over entries an older import stored with another header', async () => {
  const dir = temp(), at = (s: number) => `2026-01-02T12:00:0${s}.000Z`, model = '<command-name>/model</command-name>\n<command-args>opus</command-args>';
  const user = (uuid: string, session: string, content: string, s: number) => ({ type: 'user', uuid, sessionId: session, timestamp: at(s), message: { role: 'user', content } });
  const reply = (uuid: string, session: string, text: string, s: number) => ({ type: 'assistant', uuid, sessionId: session, timestamp: at(s),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text }] } });
  // Claude Code copies the earlier messages into the resumed file, under the new session id.
  const copied = (session: string) => [user('u1', session, model, 1), user('u2', session, 'q2', 2), reply('a2', session, 'r2', 3)];
  lines(join(dir, 'aaaa.jsonl'), copied('aaaa'));
  lines(join(dir, 'bbbb.jsonl'), [...copied('bbbb'), user('u3', 'bbbb', 'q3', 4), reply('a3', 'bbbb', 'r3', 5), user('u2', 'bbbb', 'q2 edited', 6)]);
  const read = async (id: string) => (await readConversation({ ...conversation('claude', join(dir, `${id}.jsonl`)), id })).entries;
  let memory = new Memory(join(dir, 'profile'), short);
  const text = (e: ImportedEntry) => e.text;
  try {
    const [a, b] = [await read('aaaa'), await read('bbbb')];
    assert.deepEqual(deduplicate([], [...a, ...b]).added.map(text), ['/model opus', 'q2', 'r2', 'q3', 'r3', 'q2 edited']);
    // An older import stored the original under a "[Historical …]" header and the command as Claude Code logged it; loading drops the header.
    for (const e of a) memory.append(e.kind, `[Historical claude · ${e.date} · conversation aaaa · Fixture]\n${e.text === '/model opus' ? model : e.text}`, e.date, e.receipt, e.origin);
    await memory.close(); memory = new Memory(join(dir, 'profile'), short);
    assert.deepEqual(deduplicate(memory.entries(), b).added.map(text), ['q3', 'r3', 'q2 edited'], 'a uuid with other text is another message');
  } finally { await memory.close(); removeDir(dir); }
});

test('Claude discovery checks late sidechain markers without extending metadata extraction or Codex scanning', async () => {
  const dir = temp(), parent = join(dir, 'parent.jsonl'), child = join(dir, 'renamed-child.jsonl');
  const metadata = Array.from({ length: 60 }, () => ({ type: 'file-history-snapshot' }));
  const user = { type: 'user', sessionId: 'parent', cwd: '/project', timestamp: date, message: { role: 'user', content: 'Parent request' } };
  lines(parent, [user, ...metadata.slice(1), { type: 'custom-title', sessionId: 'later', cwd: '/later', customTitle: 'Later title' }]);
  lines(child, [...metadata, { ...user, isSidechain: true }]);
  try {
    const scan = await scanLocal('claude', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    const { id, project, title, date: foundDate } = scan.conversations[0];
    assert.deepEqual({ id, project, title, date: foundDate }, { id: 'parent', project: '/project', title: 'Parent request', date });
    assert.deepEqual(scan.warnings, []);
    assert.equal((await readConversation(conversation('claude', child))).entries.length, 0);

    // Invalid JSON after line 60 would warn if Codex discovery read beyond its metadata budget.
    writeFileSync(parent, [JSON.stringify({ type: 'session_meta', payload: { id: 'codex-parent', cwd: '/project', source: 'cli', timestamp: date } }),
      ...metadata.slice(1).map(value => JSON.stringify(value)), 'not JSON'].join('\n') + '\n');
    rmSync(child);
    const codex = await scanLocal('codex', [dir]);
    assert.deepEqual(codex.conversations.map(c => c.id), ['codex-parent']);
    assert.deepEqual(codex.warnings, []);
  } finally { removeDir(dir); }
});

test('discovery continues when listed files disappear before stat or stream open', async () => {
  const dir = temp(), first = join(dir, 'a.jsonl'), beforeStat = join(dir, 'b.jsonl'), beforeOpen = join(dir, 'c.jsonl');
  for (const file of [first, beforeStat, beforeOpen]) lines(file, [{ type: 'user', sessionId: 'fixture', cwd: '/project', timestamp: date, message: { role: 'user', content: 'kept' } }]);
  const original = fs.createReadStream;
  const patched = mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    if (args[0] === first) rmSync(beforeStat);
    if (args[0] === beforeOpen) rmSync(beforeOpen);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const scan = await scanLocal('claude', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.file), [first]);
    assert.equal(scan.warnings.length, 2);
    assert.ok(scan.warnings.some(w => w.includes(beforeStat)));
    assert.ok(scan.warnings.some(w => w.includes(beforeOpen)));
    assert.ok(scan.warnings.every(w => w.includes('conversation skipped')));
  } finally { patched.mock.restore(); syncBuiltinESMExports(); removeDir(dir); }
});

test('a selected transcript disappearing warns without importing it; cancellation and unrelated I/O errors still fail', async () => {
  const dir = temp(), file = join(dir, 'selected.jsonl');
  try {
    lines(file, [{ type: 'user', uuid: 'u', message: { role: 'user', content: 'selected conversation' } }]);
    const scan = await scanLocal('claude', [dir]);
    rmSync(file);
    for (const source of ['claude', 'codex'] as const) {
      const parsed = await readConversation({ ...scan.conversations[0], source });
      assert.equal(parsed.entries.length, 0);
      assert.equal(parsed.warnings.length, 1);
      assert.match(parsed.warnings[0], /source file is no longer available/);
    }
    const reason = new Error('User cancelled');
    await assert.rejects(readConversation(scan.conversations[0], AbortSignal.abort(reason)), error => error === reason);
    await assert.rejects(readConversation(conversation('claude', dir)), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EISDIR');
  } finally { removeDir(dir); }
});

/** The ZIP fixture, built as bytes (local headers, data, central directory, EOCD), so no `zip` binary is needed. `crc` overrides the real CRC-32 to fake corruption. */
const zipArchive = (members: { name: string; data: Buffer; stored?: boolean; crc?: number }[]) => {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const method = m.stored ? 0 : 8, data = m.stored ? m.data : deflateRawSync(m.data), name = Buffer.from(m.name), crc = m.crc ?? crc32(m.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(m.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(m.data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + data.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(central.reduce((n, r) => n + r.length, 0), 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, eocd]);
};
const chatJson = (id: string, text: string) => Buffer.from(JSON.stringify([{ id, title: id, create_time: 100, mapping: {
  u: { parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 100, content: { parts: [text] } } } } }]));

test('ChatGPT ZIP reads numbered conversation files without extracting other archive data', async () => {
  const dir = temp(), file = join(dir, 'conversations_1.json'), zip = join(dir, 'export.zip');
  const data = chatJson('zip-chat', 'zip fixture message');
  writeFileSync(file, data);
  try {
    writeFileSync(zip, zipArchive([{ name: 'conversations_1.json', data }, { name: 'notes.txt', data: Buffer.from('not a conversation') }]));
    rmSync(file);
    const scan = await scanChatGPT(zip); assert.equal(scan.conversations.length, 1);
    const parsed = await readConversation(scan.conversations[0]); assert.equal(parsed.entries.length, 1);
    assert.match(parsed.entries[0].text, /zip fixture message/); assert.equal(existsSync(file), false);
  } finally { removeDir(dir); }
});

test('a ChatGPT ZIP reads stored and deflated members, and refuses a corrupt member or a file that is not a ZIP', async () => {
  const dir = temp(), zip = join(dir, 'export.zip'), corrupt = join(dir, 'corrupt.zip'), fake = join(dir, 'fake.zip');
  const stored = chatJson('stored-chat', 'stored member message'), deflated = chatJson('deflated-chat', 'deflated member message');
  writeFileSync(zip, zipArchive([{ name: 'conversations_1.json', data: stored, stored: true }, { name: 'export/conversations_2.json', data: deflated }]));
  writeFileSync(corrupt, zipArchive([{ name: 'conversations.json', data: stored, crc: (crc32(stored) ^ 1) >>> 0 }]));
  writeFileSync(fake, 'not a zip at all');
  try {
    const scan = await scanChatGPT(zip);
    assert.deepEqual(scan.conversations.map(c => [c.id, c.file]).sort(), [[`deflated-chat`, `${zip}:export/conversations_2.json`], ['stored-chat', `${zip}:conversations_1.json`]]);
    for (const c of scan.conversations) assert.deepEqual(c.exported, JSON.parse(String(c.id === 'stored-chat' ? stored : deflated))[0]);
    await assert.rejects(scanChatGPT(corrupt), /Could not read conversations\.json in .*Extract the ZIP and select the folder instead\./);
    // The tool's own reason, not just the file name unzip prints first.
    await assert.rejects(scanChatGPT(fake), /Could not read .*fake\.zip: (?!\[)\S.*\. Extract the ZIP and select the folder instead\./);
  } finally { removeDir(dir); }
});

test('Claude memories import each topic file once as a dated note, and an edited file as a newer note', async () => {
  const root = temp(), alpha = join(root, '-tmp-alpha'), beta = join(root, '-work-beta');
  for (const dir of [join(alpha, 'memory'), join(alpha, 'session', 'session-memory'), join(beta, 'memory')]) mkdirSync(dir, { recursive: true });
  lines(join(alpha, 'session.jsonl'), [{ type: 'user', cwd: '/tmp/alpha', message: { role: 'user', content: 'hi' } }]);
  writeFileSync(join(alpha, 'memory', 'MEMORY.md'), '- [Deploys](feedback_deploys.md) INDEX ONLY\n');
  writeFileSync(join(alpha, 'session', 'session-memory', 'summary.md'), 'SESSION SUMMARY\n');
  const deploys = join(alpha, 'memory', 'feedback_deploys.md');
  writeFileSync(deploys, '---\nname: Deploys\ndescription: "Never deploy on \\"Fridays\\""\ntype: feedback\nmodified: 2026-03-04T05:06:07.000Z\n---\nWait until Monday.\n');
  const pr = join(beta, 'memory', 'project_pr.md');
  writeFileSync(pr, '---\nname: PR status\ndescription: Tracking PR\nmetadata:\n  type: project\n---\nPR #7023 is open.\n');
  utimesSync(pr, new Date(date), new Date(date));
  try {
    const scan = await scanClaudeMemories(root);
    assert.deepEqual(scan.warnings, []);
    const read = async () => (await Promise.all(scan.conversations.map(c => readConversation(c)))).flatMap(p => p.entries);
    const first = await read();
    assert.deepEqual(first.map(e => [e.kind, e.date, e.origin?.project, e.origin?.title]), [
      ['note', '2026-03-04T05:06:07.000Z', '/tmp/alpha', 'Deploys'],
      ['note', date, '-work-beta', 'PR status'],
    ]);
    assert.equal(first[0].text, '[Claude Code memory · project /tmp/alpha · type feedback · Deploys]\nNever deploy on "Fridays"\n\nWait until Monday.');
    assert.match(first[1].text, /project -work-beta · type project · PR status\]\nTracking PR\n\nPR #7023 is open\.$/);
    assert.doesNotMatch(JSON.stringify(first), /INDEX ONLY|SESSION SUMMARY/);
    const existing = first.map((e, i) => ({ ...e, i, size: 0 }));
    assert.deepEqual(deduplicate(existing, await read()), { added: [], skipped: 2 });
    writeFileSync(pr, readFileSync(pr, 'utf8').replace('is open', 'is merged'));
    const { added } = deduplicate(existing, await read());
    assert.equal(added.length, 1); assert.match(added[0].text, /PR #7023 is merged/); assert.ok(added[0].date > date, 'edited note is dated by the read, not the scan');
  } finally { removeDir(root); }
});

test('append activates only after complete indexing, retains original summaries, and repeated imports add nothing', async () => {
  const dir = temp(); const old = new Memory(dir, short);
  let activated: Memory | undefined;
  try {
    old.append('user', 'original exact message', '2026-06-01T00:00:00.000Z');
    await old.settle(undefined, 'tree'); await old.close();
    const original = old.node({ l: 0, i: 0 });
    const job = prepareImport(dir, old, [entry('one'), entry('one')], 'append'); assert.ok(job);
    assert.equal(job.added, 1); assert.equal(job.skipped, 1); assert.equal(memoryDirectory(dir), dir);
    await runImport(dir, short, AbortSignal.timeout(5000));
    assert.equal(pendingImport(dir), undefined); assert.notEqual(memoryDirectory(dir), dir);
    activated = new Memory(memoryDirectory(dir), short);
    assert.deepEqual(activated.node({ l: 0, i: 0 }), original);
    assert.equal(activated.text(0), 'original exact message');
    assert.equal(activated.root[1].receipt, 'import:one');
    assert.deepEqual(activated.root[1].origin, entry('one').origin);
    assert.match(activated.zoom(1, 1), /Imported one/);
    assert.deepEqual(deduplicate(activated.entries(), [entry('one')]), { added: [], skipped: 1 });
    assert.ok(existsSync(join(dir, 'main')));
    // A second import starts from the generation the first one made, which the journal names as a portable path.
    await activated.close();
    prepareImport(dir, activated, [entry('two')], 'append');
    await runImport(dir, short, AbortSignal.timeout(5000));
    activated = new Memory(memoryDirectory(dir), short);
    assert.deepEqual(activated.root.map(e => e.receipt).slice(1), ['import:one', 'import:two']);
  } finally { await old.close(); await activated?.close(); removeDir(dir); }
});

test('paused imports retain completed summaries, resume from disk, and preserve prior generation through rebuild', async () => {
  const dir = temp(); const old = new Memory(dir, short);
  let current: Memory | undefined;
  try {
    old.append('user', 'native later', '2026-06-01T00:00:00.000Z'); await old.settle(undefined, 'tree'); await old.close();
    prepareImport(dir, old, [entry('a'), entry('b', date, 'large '.repeat(200))], 'rebuild');
    await assert.rejects(runImport(dir, async (_input, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return '';
    }, AbortSignal.timeout(50)));
    assert.equal(memoryDirectory(dir), dir); assert.ok(pendingImport(dir));
    const staged = new Memory(join(dir, pendingImport(dir)!.target), short); const saved = staged.tree.size; await staged.close();
    assert.ok(saved >= 1);
    await runImport(dir, short, AbortSignal.timeout(5000));
    current = new Memory(memoryDirectory(dir), short);
    assert.equal(current.root[0].receipt, 'import:a'); assert.equal(current.text(current.root.length - 1), 'native later');
    assert.ok(current.tree.size >= saved);
    assert.ok(readFileSync(join(dir, 'main', localDay() + '.jsonl'), 'utf8').includes('native later'));
  } finally { await old.close(); await current?.close(); removeDir(dir); }
});

test('discard leaves original memory active and a completed pointer swap can finish recovery idempotently', async () => {
  const dir = temp(), old = new Memory(dir, short);
  try {
    old.append('user', 'original'); await old.settle(undefined, 'tree'); await old.close();
    const discarded = prepareImport(dir, old, [entry('discard')], 'append'); assert.ok(discarded);
    discardImport(dir); assert.equal(memoryDirectory(dir), dir); assert.equal(pendingImport(dir), undefined);
    const job = prepareImport(dir, old, [entry('keep')], 'append'); assert.ok(job);
    await runImport(dir, short, AbortSignal.timeout(5000));
    const staged = join(dir, job.target, 'staged.jsonl');
    assert.ok(!existsSync(staged), 'an activated import keeps no second copy of its log');
    // Simulate a crash right after the durable pointer write, before the staged plan and the journal were removed.
    writeFileSync(staged, '');
    writeFileSync(join(dir, 'imports', 'pending.json'), JSON.stringify(job));
    await runImport(dir, short, AbortSignal.timeout(5000));
    assert.equal(pendingImport(dir), undefined);
    assert.ok(!existsSync(staged));
    assert.equal(memoryDirectory(dir), join(dir, job.target));
    assert.ok(existsSync(join(dir, 'imports', `${job.id}.json`)));
  } finally { await old.close(); removeDir(dir); }
});

for (const jobs of [undefined, 3, 16]) test(`an import summarizes ${jobs ?? '8 (default)'} messages at once, and its merges keep the compactions' view in budget`, async () => {
  // 120 summaries of 500 bytes overflow the compactions' 32 KB view, so it must merge while messages are still being logged.
  const dir = temp(), old = new Memory(dir, short);
  const imported = Array.from({ length: 120 }, (_, i) => entry(`m${i}`, date, `${i} ${'imported detail '.repeat(40)}`));
  let leaves = 0, peak = 0, widest = 0;
  const compress: Compressor = async input => {
    widest = Math.max(widest, bytes(input.context));
    if (input.part.l) return input.source.slice(0, 500);
    peak = Math.max(peak, ++leaves);
    await new Promise(resolve => setTimeout(resolve, 5));
    leaves--; return input.source.slice(0, 500);
  };
  try {
    await old.close();
    assert.ok(prepareImport(dir, old, imported, 'append'));
    await runImport(dir, compress, AbortSignal.timeout(20000), jobs);
    assert.equal(peak, jobs ?? 8);
    assert.ok(widest < 40_000, `compaction view reached ${widest} bytes`);
  } finally { removeDir(dir); }
});

test('append keeps the saved view with the tree, so the old view stays cached; rebuild starts without one', async () => {
  const dir = temp(), old = new Memory(dir, short);
  try {
    old.append('user', 'original'); await old.settle(undefined, 'tree'); await old.close();
    writeFileSync(join(dir, 'view.json'), '[[0,0]]');
    const appended = prepareImport(dir, old, [entry('a')], 'append'); assert.ok(appended);
    assert.equal(readFileSync(join(dir, appended.target, 'view.json'), 'utf8'), '[[0,0]]');
    discardImport(dir);
    const rebuilt = prepareImport(dir, old, [entry('b')], 'rebuild'); assert.ok(rebuilt);
    assert.equal(existsSync(join(dir, rebuilt.target, 'view.json')), false);
  } finally { removeDir(dir); }
});

test('a staged plan with an invalid entry, or missing lines, is refused before anything is written', async () => {
  const dir = temp(), old = new Memory(dir, short);
  try {
    old.append('user', 'original'); await old.settle(undefined, 'tree'); await old.close();
    const job = prepareImport(dir, old, [entry('a'), entry('b'), entry('c')], 'append'); assert.ok(job);
    const staged = join(dir, job.target, 'staged.jsonl'), plan = readFileSync(staged, 'utf8'), lines = plan.split('\n').filter(Boolean);
    const damaged = {
      'a bad entry': plan.replace('"kind":"user","text":"Imported b"', '"kind":"bogus","text":"Imported b"'),
      'a missing middle line': [lines[0], lines[1], lines[3]].join('\n') + '\n',
      'a truncated tail': lines.slice(0, 3).join('\n') + '\n',
    };
    for (const [name, text] of Object.entries(damaged)) {
      writeFileSync(staged, text);
      await assert.rejects(runImport(dir, short, AbortSignal.timeout(5000)), /invalid/, name);
      assert.equal(memoryDirectory(dir), dir);
      assert.deepEqual(readdirSync(join(dir, job.target, 'main')), ['000-import.jsonl']);
    }
  } finally { removeDir(dir); }
});

test('chronological rebuild keeps imported conversations and native turns together', () => {
  const first = entry('conversation', date), later = { ...entry('conversation', '2026-12-01T00:00:00.000Z'), receipt: 'import:second' };
  const native: ImportedEntry = { kind: 'user', text: 'native', date: '2026-06-01T00:00:00.000Z' };
  assert.deepEqual(chronological([native, first, later]).map(e => e.text), [first.text, later.text, native.text]);
});

test('chronological rebuild keeps an imported message without an origin out of native turns', () => {
  const turn = (text: string, at: string): ImportedEntry[] => [{ kind: 'user', text, date: at }, { kind: 'talk', text: `re ${text}`, date: at }];
  const bare: ImportedEntry = { kind: 'talk', text: 'old reply', date, receipt: 'import:bare' };
  const natives = [...turn('one', '2026-06-01T00:00:00.000Z'), ...turn('two', '2026-07-01T00:00:00.000Z')];
  assert.deepEqual(chronological([...natives, bare]).map(e => e.text), ['old reply', 'one', 're one', 'two', 're two']);
});

test('a failed progress dialog cancels and joins its worker before returning', async () => {
  const dir = temp(), old = new Memory(dir, short); await old.close();
  try {
    const job = prepareImport(dir, old, [entry('large', date, 'long '.repeat(200))], 'append'); assert.ok(job);
    let stopped = false;
    const ui = { select: async () => { throw new Error('UI closed'); }, input: async () => undefined,
      confirm: async () => false, notify: () => {}, setWidget: () => {} };
    await assert.rejects(showProgress({ ui }, job, async signal => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
    }, new AbortController().signal), /UI closed/);
    assert.equal(stopped, true);
    assert.equal(memoryDirectory(dir), dir);
  } finally { removeDir(dir); }
});

test('preparation source dialog receives shutdown cancellation before staging any data', async () => {
  const dir = temp(), memory = new Memory(dir, short), controller = new AbortController();
  try {
    const ui = { select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
      assert.equal(opts?.signal, controller.signal);
      return new Promise<undefined>(resolve => opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true }));
    }, input: async () => undefined, confirm: async () => false, notify: () => {}, setWidget: () => {}, custom: async () => { throw new Error('unexpected picker'); } };
    const task = chooseImport({ ui }, 'test', memory, 'fixture', controller.signal); controller.abort();
    assert.equal(await task, undefined); assert.equal(pendingImport(dir), undefined);
  } finally { await memory.close(); removeDir(dir); }
});

test('an imported message is its text alone; its conversation note names the source, title, project, days and 13 characters of the id', async () => {
  const dir = temp(), claude = join(dir, 'claude.jsonl'), codex = join(dir, 'codex.jsonl');
  lines(claude, [{ type: 'user', uuid: 'u', timestamp: date, message: { role: 'user', content: 'question' } }]);
  lines(codex, [{ type: 'response_item', timestamp: date, payload: { type: 'message', id: 'u', role: 'user', content: [{ type: 'input_text', text: 'question' }] } }]);
  try {
    for (const [source, file, id] of [['claude', claude, 'cbcb64a5-871a-4179-a897-e3683852d011'], ['codex', codex, '0199c0de-1111-7222-8333-444455556666']] as const) {
      const c = { ...conversation(source, file), id }, { entries } = await readConversation(c);
      assert.deepEqual(entries.map(e => [e.text, e.origin?.conversation]), [['question', id]]);
      const [note] = withNotes([{ ...entries[0], date: '2026-01-05T09:00:00.000Z' }, entries[0]]);
      assert.deepEqual([note.kind, note.date, note.text], ['note', date, `Imported ${source} conversation "Fixture" in /synthetic, 2026-01-02 to 2026-01-05, id ${id.slice(0, 13)}.`]);
    }
  } finally { removeDir(dir); }
});

test('re-importing a conversation adds nothing, and a later message comes with one note', async () => {
  const dir = temp(), file = join(dir, 'claude.jsonl'), memory = new Memory(join(dir, 'profile'), short);
  const user = (uuid: string, content: string) => ({ type: 'user', uuid, timestamp: date, message: { role: 'user', content } });
  const fresh = async () => withNotes(deduplicate(memory.entries(), (await readConversation(conversation('claude', file))).entries).added);
  try {
    lines(file, [user('u1', 'first'), user('u2', 'second')]);
    const first = await fresh();
    assert.deepEqual(first.map(e => e.kind === 'note' ? 'note' : e.text), ['note', 'first', 'second']);
    for (const e of first) memory.append(e.kind, e.text, e.date, e.receipt, e.origin);
    assert.deepEqual(await fresh(), []);
    lines(file, [user('u1', 'first'), user('u2', 'second'), user('u3', 'third')]);
    assert.deepEqual((await fresh()).map(e => e.kind === 'note' ? 'note' : e.text), ['note', 'third']);
  } finally { await memory.close(); removeDir(dir); }
});

test('a time without a zone is UTC whatever the machine zone', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    assert.equal(timestamp('2026-01-02T12:00:00', 'x'), '2026-01-02T12:00:00.000Z');
    assert.equal(timestamp('2026-01-02 12:00', 'x'), '2026-01-02T12:00:00.000Z');
    assert.equal(timestamp('2026-01-02T12:00:00-03:00', 'x'), '2026-01-02T15:00:00.000Z');
    assert.equal(timestamp(1767355200, 'x'), '2026-01-02T12:00:00.000Z');
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});

test('a number is seconds, or milliseconds when it is too large to be seconds', () => {
  assert.equal(timestamp(1767261600.5, 'x'), '2026-01-01T10:00:00.500Z');
  assert.equal(timestamp(1767261600123, 'x'), '2026-01-01T10:00:00.123Z');
});

test('an out-of-range or invalid time falls back without throwing', () => {
  for (const bad of [1e20, -1e20, 1e16, NaN, Infinity, 'not a time', undefined, null]) assert.equal(timestamp(bad, 'fallback'), 'fallback');
});

test('a ChatGPT conversation with a very long chain of replies imports in order, and a parent cycle is still rejected', async () => {
  const nodes = 20_000, mapping: Record<string, unknown> = {};
  for (let i = nodes - 1; i >= 0; i--) mapping[`n${i}`] = { parent: i ? `n${i - 1}` : null,
    message: { id: `m${i}`, author: { role: i % 2 ? 'assistant' : 'user' }, end_turn: true, content: { parts: [`message ${i}`] } } };
  const chat = (exported: Record<string, unknown>) => ({ ...conversation('chatgpt', 'export.json'), exported });
  const parsed = await readConversation(chat({ mapping, current_node: `n${nodes - 1}` }));
  assert.deepEqual(parsed.entries.slice(0, 3).map(e => e.origin?.message), ['m0', 'm1', 'm2']);
  const loop = { a: { parent: 'b', message: { author: { role: 'user' }, content: { parts: ['a'] } } }, b: { parent: 'a', message: { author: { role: 'user' }, content: { parts: ['b'] } } } };
  await assert.rejects(readConversation(chat({ mapping: loop })), /cycle in ChatGPT conversation mapping/);
});

test('a Claude memory with a folded or literal YAML description imports the text, not the indicator', async () => {
  const root = temp(), memory = join(root, '-tmp-alpha', 'memory'); mkdirSync(memory, { recursive: true });
  const note = (name: string, description: string) => writeFileSync(join(memory, `${name}.md`), `---\nname: ${name}\n${description}\ntype: user\n---\nbody of ${name}\n`);
  note('folded', 'description: >\n  a long\n  description: with a colon\n\n  second paragraph');
  note('literal', 'description: |-\n  first line\n  second line');
  note('plain', 'description: one line');
  try {
    const scan = await scanClaudeMemories(root);
    const texts = new Map<string, string[]>();
    for (const c of scan.conversations) texts.set(c.title, (await readConversation(c)).entries[0].text.split('\n'));
    assert.deepEqual(texts.get('folded')?.slice(1, 3), ['a long description: with a colon second paragraph', '']);
    assert.deepEqual(texts.get('literal')?.slice(1, 3), ['first line second line', '']);
    assert.deepEqual(texts.get('plain')?.slice(1, 3), ['one line', '']);
    for (const lines of texts.values()) assert.match(lines[0], /· type user · /, 'a key after the block still parses');
  } finally { removeDir(root); }
});

test('core builds an import in any store: a paused rebuild resumes from what the store holds and switches once, when complete', async () => {
  const saved = { entries: [] as Entry[], tree: [] as Summary[], view: undefined as string | undefined };
  const store: Store = { load: () => structuredClone(saved), append: e => void saved.entries.push(e), appendNode: n => void saved.tree.push(n),
    text: i => saved.entries[i].text, summary: p => saved.tree.findLast(n => n.l === p.l && n.i === p.i)!.text,
    saveView: view => void (saved.view = view), putImage: () => undefined, image: () => undefined };
  const native: Entry = { i: 0, kind: 'user', text: 'native later', date: '2026-06-01T00:00:00.000Z' };
  const plan = planImport([native], [entry('a', date, 'large '.repeat(200)), entry('b', date, 'long '.repeat(200)), entry('a')], 'rebuild');
  assert.ok(plan); assert.equal(plan.kept, 0); assert.equal(plan.skipped, 1);
  // The first summary pauses the import, and waits until the import closes the memory.
  const pause = new AbortController();
  let stall = true;
  const compress: Compressor = (input, signal) => !stall ? short(input, signal)
    : new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); pause.abort(); });
  const switched: CoreMemory[] = [];
  const run = (signal: AbortSignal) => runCore({ entry: i => plan.entries[i], total: plan.entries.length, activate: async () => void switched.push(await openMemory(store, short)),
    open: () => openMemory(store, compress, { warn: () => {}, jobs: 1 }) }, signal);
  await assert.rejects(run(pause.signal));
  assert.equal(switched.length, 0);
  assert.ok(saved.entries.length > 0 && saved.entries.length < plan.entries.length, 'paused part way');
  stall = false;
  await run(AbortSignal.timeout(5000));
  assert.equal(switched.length, 1); await switched[0].close();
  assert.deepEqual(switched[0].entries().map(e => e.text), plan.entries.map(e => e.text));
  assert.equal(switched[0].pending, 0);
});

test('core import refuses a plan length that is not a count', async () => {
  let opened = false;
  await assert.rejects(runCore({ entry: () => undefined, total: NaN, open: async () => { opened = true; return openMemory({ load: () => ({ entries: [], tree: [] }),
    text: () => '', summary: () => '', append: () => undefined, appendNode: () => undefined, saveView: () => undefined, putImage: () => undefined, image: () => undefined }, short); },
    activate: () => assert.fail('switched') }, AbortSignal.timeout(5000)), /invalid/);
  assert.equal(opened, false);
});

test('core import does not switch to a staging log whose last write failed in a store that writes behind', async () => {
  const saved = { entries: [] as Entry[], tree: [] as Summary[], view: undefined as string | undefined };
  const store: Store = { load: () => structuredClone(saved), appendNode: n => void saved.tree.push(n), saveView: view => void (saved.view = view),
    text: i => saved.entries[i].text, summary: p => saved.tree.findLast(n => n.l === p.l && n.i === p.i)!.text,
    append: async e => { if (e.text === 'Imported b') throw new Error('offline'); saved.entries.push(e); }, putImage: () => undefined, image: () => undefined };
  const plan = planImport([], [entry('a'), entry('b')], 'rebuild'); assert.ok(plan);
  let switched = false;
  await assert.rejects(runCore({ entry: i => plan.entries[i], total: plan.entries.length, open: () => openMemory(store, short, { warn: () => {} }),
    activate: () => { switched = true; } }, AbortSignal.timeout(5000)), /offline/);
  assert.equal(switched, false);
});
