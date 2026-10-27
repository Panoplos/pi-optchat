import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { buildContext, messageChars, refreshBudget, refreshedRun, refreshFraction, refreshPoint, textContent, turnStepUsage, turnUsage } from '../src/transcript.ts';
const chars = (messages: readonly AgentMessage[]) => messages.reduce((sum, m) => sum + messageChars(m), 0);
import { parsePercent } from '../src/settings-page.ts';
import { invalid } from '../src/settings.ts';
import { subagentCompaction } from '../src/agents.ts';
import { COMPACT, TURN_REFRESHED } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const reply = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
  role: 'assistant', content, timestamp: 2, stopReason, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(),
});

test('with the refresh off the request is the one sent before mid-turn refresh existed', () => {
  assert.equal(refreshBudget(200_000, Number(undefined)), undefined);
  assert.equal(refreshBudget(200_000, 0), undefined);
  assert.equal(refreshBudget(200_000, 0.25), 200_000);
  const run: AgentMessage[] = [{ role: 'user', content: 'task', timestamp: 1 }, reply([{ type: 'toolCall', id: 't', name: 'date', arguments: { id: 0 } }], 'toolUse'),
    { role: 'toolResult', toolCallId: 't', toolName: 'date', content: [{ type: 'text', text: 'Fri' }], isError: false, timestamp: 3 }];
  assert.deepEqual(buildContext([], refreshedRun(run, 0, TURN_REFRESHED), '<chat>\n</chat>', 'p'), buildContext([], run, '<chat>\n</chat>', 'p'));
});

test('the threshold is typed as 30, 30% or 0.3, OPTCHAT_REFRESH_AT overrides it, and 0 turns it off', () => {
  assert.deepEqual(['30', '30%', '0.3', '8', '0', 'abc'].map(parsePercent), [0.3, 0.3, 0.3, 0.08, 0, NaN]);
  assert.match(invalid('refreshAt', 0.95) ?? '', /from 0% to 90%/);
  assert.equal(refreshFraction(0.3, undefined), 0.3);
  assert.equal(refreshFraction(0.3, '0.08'), 0.08);
  assert.equal(refreshBudget(200_000, refreshFraction(0.3, '0')), undefined);
});

test('the footer figure is the tail against the refresh budget, and nothing when the refresh is off', () => {
  const run: AgentMessage[] = [{ role: 'user', content: 'task', timestamp: 1 },
    { role: 'user', content: 'y'.repeat(80), timestamp: 2 }];
  assert.deepEqual(turnUsage(run, 1, 400), { tokens: 20, contextWindow: 100, percent: 20 }, 'the tail alone, not the task');
  assert.equal(turnUsage(run, 0, undefined), undefined, 'off, so Pi keeps showing its own figure');
  assert.equal(turnUsage(run, 1, 40)?.percent, 200, 'a step over the budget reads past 100%');
});

test('while a push runs the footer reads full against the threshold, with the step memory is on', () => {
  assert.deepEqual(turnStepUsage(400, 'summarizing'), { tokens: 100, contextWindow: 100, percent: 100, label: 'summarizing' });
  assert.equal(turnStepUsage(400, undefined), undefined, 'nothing to report, so the figure stays where it was');
  assert.equal(turnStepUsage(undefined, 'merging'), undefined, 'the refresh is off');
});

test('a step too big to keep whole is refreshed anyway, its tail cut to the budget', () => {
  const step = (id: string, text: string): AgentMessage[] => [reply([{ type: 'toolCall', id, name: 'read', arguments: {} }], 'toolUse'),
    { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: 3 }];
  const run: AgentMessage[] = [{ role: 'user', content: 'task', timestamp: 1 }, ...step('a', 'x'.repeat(600)), ...step('b', 'x'.repeat(600))];
  assert.equal(refreshPoint(run, 0, 1000)?.cut, 3, 'the step is no longer a reason to wait');
  const sent = chars(refreshedRun(run, 3, TURN_REFRESHED, 1000));
  assert.ok(sent <= 1000, `the tail is held to the budget (${sent} characters)`);
  assert.equal(messageChars({ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', data: '', mimeType: 'image/png' }], timestamp: 1 }), 4_802, 'images count as Pi estimates them');
});

test('many parallel tool results are cut to the same cap instead of overflowing the window', () => {
  const results = Array.from({ length: 5 }, (_, i): AgentMessage => ({ role: 'toolResult', toolCallId: `t${i}`, toolName: 'bash',
    content: [{ type: 'text', text: `${i}`.repeat(20_000) }], isError: false, timestamp: 3 }));
  const run: AgentMessage[] = [{ role: 'user', content: 'task', timestamp: 1 },
    reply(Array.from({ length: 5 }, (_, i) => ({ type: 'toolCall' as const, id: `t${i}`, name: 'bash', arguments: {} })), 'toolUse'), ...results];
  const budget = 60_000;
  assert.equal(refreshPoint(run, 0, budget)?.cut, 1, 'the oversized step still refreshes');
  const sent = refreshedRun(run, 1, TURN_REFRESHED, budget);
  assert.ok(chars(sent) <= budget, `sent ${chars(sent)} of a ${budget}-character budget`);
  const texts = sent.filter(m => m.role === 'toolResult').map(m => textContent(m.content));
  assert.equal(new Set(texts.map(text => text.length)).size, 1, 'every result keeps the same share, the budget over eight');
  assert.ok(texts.every(text => text.includes('the view keeps this message as one memory line')), 'each is a pointer to memory');
  assert.equal(sent.filter(m => m.role === 'assistant').length, 1, 'the step keeps its tool calls, so results still match them');
  assert.ok(sent.some(m => m.role === 'assistant' && m.content.filter(b => b.type === 'toolCall').length === 5));
});

test('a message already sent stays byte-identical as the step grows, so the next call reads its cache', () => {
  const big = (at: number): AgentMessage[] => [reply([{ type: 'toolCall', id: `t${at}`, name: 'bash', arguments: {} }], 'toolUse'),
    { role: 'toolResult', toolCallId: `t${at}`, toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(20_000) }], isError: false, timestamp: 3 }];
  const task: AgentMessage = { role: 'user', content: 'task', timestamp: 1 };
  const budget = 40_000;
  const first = refreshedRun([task, ...big(1), ...big(2)], 1, TURN_REFRESHED, budget);
  const second = refreshedRun([task, ...big(1), ...big(2), ...big(3)], 1, TURN_REFRESHED, budget);
  assert.deepEqual(second.slice(0, first.length).map(m => JSON.stringify(m)), first.map(m => JSON.stringify(m)),
    'what the next call sends starts with exactly the bytes of the last call');
  assert.equal(refreshPoint([task, ...big(1), ...big(2), ...big(3)], 1, budget)?.cut, 5, 'the refresh still advances as the turn grows');
});

test('subagents use Pi compaction at about the refresh threshold on top of the view, or Pi\'s default when it is off', () => {
  assert.deepEqual(subagentCompaction(200_000, 0.3), { enabled: true, reserveTokens: 108_000 });
  assert.deepEqual(subagentCompaction(200_000, 0), { enabled: true });
});

test('a turn past its threshold is sent as the refreshed view, its task verbatim and only its last tool call, and memory logs every step once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-refresh-'));
  const oldHome = process.env.OPTCHAT_HOME, oldBudget = process.env.OPTCHAT_REFRESH_AT;
  process.env.OPTCHAT_HOME = dir;
  // A 1,000-token window at 100%: 4,000 characters, about four of the zooms below plus the task.
  process.env.OPTCHAT_REFRESH_AT = '1';
  const task = `Zoom message 0 eight times, then answer. ${'Context for the task. '.repeat(38)}`;
  const captured: Context[] = [];
  let calls = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        if (!compression) captured.push(structuredClone({ ...context, messages: context.messages.filter(m => m.role !== 'system') }));
        const step = compression ? 0 : ++calls;
        const message = compression ? reply([{ type: 'text', text: 'Summary.' }], 'stop')
          : step <= 8 ? reply([{ type: 'toolCall', id: `zoom-${step}`, name: 'zoom', arguments: { id: 0, n: 1 } }], 'toolUse')
          : reply([{ type: 'text', text: 'Done.' }], 'stop');
        message.provider = model.provider; message.model = model.id;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    await session.prompt(task);
    assert.equal(session.getLastAssistantText(), 'Done.');
    assert.deepEqual(captured.map(c => c.messages.map(m => m.role).join(' ')), [
      'user', 'user assistant toolResult', 'user assistant toolResult assistant toolResult', 'user assistant toolResult assistant toolResult assistant toolResult',
      // Over the threshold: the view now has the turn so far as lines, and the request only the task and the fourth step verbatim.
      'user assistant toolResult', 'user assistant toolResult assistant toolResult', 'user assistant toolResult assistant toolResult assistant toolResult',
      'user assistant toolResult assistant toolResult assistant toolResult assistant toolResult',
      // Over again, counted from the last refresh.
      'user assistant toolResult']);
    const [first, refreshed] = [captured[0].messages[0], captured[4].messages[0]].map(m => textContent(m.content));
    assert.ok(first.endsWith(task) && !first.includes(TURN_REFRESHED));
    assert.ok(refreshed.includes(`\n\n${task}`) && refreshed.endsWith(TURN_REFRESHED), 'the task stays verbatim, then the note');
    const view = refreshed.slice(0, refreshed.indexOf('</chat>'));
    assert.ok(view.includes('|tool: zoom {"id":0,"n":1}') && view.includes('2+1|Summary.'), 'the moved steps are view lines');
    const ids = captured.map(c => c.messages.flatMap(m => m.role === 'assistant' ? m.content.flatMap(b => b.type === 'toolCall' ? [b.id] : []) : []).join(' '));
    assert.deepEqual([ids[4], ids[8]], ['zoom-4', 'zoom-8']);
    const main = join(dir, 'profiles', 'fixture', 'main');
    const kinds = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => (JSON.parse(line) as { kind: string }).kind);
    assert.deepEqual(kinds, ['user', ...Array.from({ length: 8 }, () => ['tool', 'echo']).flat(), 'talk'], 'each step logged once');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldBudget === undefined) delete process.env.OPTCHAT_REFRESH_AT; else process.env.OPTCHAT_REFRESH_AT = oldBudget;
    removeDir(dir);
  }
});
