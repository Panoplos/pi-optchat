import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, defaults, loadConfig, profilePath, roleChoice, saveConfig } from '../src/profiles.ts';
import { createCompressor, type ModelChoice } from '../src/compactor.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const model = (id: string, reasoning: boolean) =>
  ({ id, name: id, reasoning, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 });

/** Opens the `fixture` profile in a Pi session that starts on fixture/plain, as Pi's global default would pick it. */
async function open(dir: string, main: ModelChoice | undefined, sessions: { close: () => Promise<void> }[]) {
  const profile = profilePath('fixture'), fixture = { provider: 'fixture', model: 'plain', thinking: 'off' as const };
  saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture, ...main && { main } });
  const written = () => statSync(join(profile, 'config.json')).mtimeMs, before = written();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [model('plain', false), model('deep', true)] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'plain'), resourceLoader: loader, settingsManager, sessionManager: manager });
  const notes: string[] = [];
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notes.push(text); } }, mode: 'print' });
  const opened = { session, runtime, notes, saved: () => loadConfig(profile).main, untouched: () => written() === before,
    close: async () => { sessions.splice(sessions.indexOf(opened), 1); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } };
  sessions.push(opened);
  return opened;
}

test('the main model and thinking level follow the profile', async () => {
  // macOS's default TMPDIR can push the profile's lock socket past the Unix socket path limit.
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'oc-main-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  const sessions: { close: () => Promise<void> }[] = [];
  try {
    createProfile('fixture');
    const first = await open(dir, undefined, sessions);
    assert.equal(first.session.model?.id, 'plain', 'nothing saved yet: Pi keeps its own pick');
    assert.deepEqual(first.saved(), { provider: 'fixture', model: 'plain', thinking: 'off' }, 'the first open records where Pi is, so the profile stops following Pi');
    await first.session.setModel(first.runtime.getModel('fixture', 'deep')!);
    first.session.setThinkingLevel('low');
    assert.deepEqual(first.saved(), { provider: 'fixture', model: 'deep', thinking: 'low' });
    await first.close();

    const second = await open(dir, first.saved(), sessions);
    assert.equal(second.session.model?.id, 'deep', 'reopening picks the saved model over Pi\'s default');
    assert.equal(second.session.thinkingLevel, 'low');
    assert.ok(second.untouched(), 'restoring writes nothing back');
    assert.deepEqual(second.notes.filter(n => n.includes('main model')), []);
    await second.close();

    const argv = process.argv;
    process.argv = [...argv, '--thinking', 'high'];
    const flagged = await open(dir, first.saved(), sessions).finally(() => { process.argv = argv; });
    assert.equal(flagged.session.model?.id, 'deep');
    assert.equal(flagged.session.thinkingLevel, 'high', '--thinking on the command line wins over the saved level');
    assert.ok(flagged.untouched(), 'and is not saved as the profile\'s pick');
    flagged.session.setThinkingLevel('low'); flagged.session.setThinkingLevel('high');
    for (let i = 0; i < 100 && flagged.saved()?.thinking !== 'high'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(flagged.saved()?.thinking, 'high', 'picking the flag\'s level by hand afterwards is saved');
    await flagged.close();

    const gone = await open(dir, { provider: 'fixture', model: 'retired', thinking: 'high' }, sessions);
    assert.equal(gone.session.model?.id, 'plain', 'a model that no longer exists leaves Pi\'s pick alone');
    assert.deepEqual(gone.notes.filter(n => n.includes('main model')), ['fixture\'s main model fixture/retired is unavailable; keeping fixture/plain.']);
    await gone.close();
  } finally {
    for (const session of [...sessions]) await session.close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('the compactor defaults to the model Pi is on and follows a switch', async () => {
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'oc-follow-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const sessions: { close: () => Promise<void> }[] = [];
  const summarized: string[] = [];
  try {
    createProfile('fixture');
    const profile = profilePath('fixture');
    // No compactor and no subagent in config.json: both follow the model Pi is on.
    assert.equal(loadConfig(profile).compactor, undefined);
    assert.equal(loadConfig(profile).subagent, undefined);
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [model('plain', false), model('deep', true)],
      streamSimple(selected) {
        summarized.push(selected.id);
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Summary.' }], timestamp: Date.now(),
          stopReason: 'stop', api: selected.api, provider: selected.provider, model: selected.id, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      } });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const open = async () => {
      await loader.reload();
      const manager = SessionManager.create(dir, join(dir, 'sessions'));
      manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
      const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'plain'), resourceLoader: loader, settingsManager, sessionManager: manager });
      const notes: string[] = [], errors: string[] = [];
      await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notes.push(text); } }, mode: 'print', onError: error => { errors.push(error.error); } });
      const opened = { session, notes, errors, close: async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } };
      sessions.push(opened);
      return opened;
    };

    const first = await open();
    assert.ok(first.notes.some(n => n.includes('Compactor: fixture/plain')), `the compactor follows Pi's model: ${first.notes.join(' / ')}`);
    await first.session.setModel(runtime.getModel('fixture', 'deep')!);
    for (let i = 0; i < 100 && loadConfig(profile).main?.model !== 'deep'; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(loadConfig(profile).main, { provider: 'fixture', model: 'deep', thinking: 'off' });
    await first.close();
    await new Promise(r => setTimeout(r, 300));

    const second = await open();
    assert.ok(second.notes.some(n => n.includes('Compactor: fixture/deep')), `the saved pick is the model it follows: ${second.notes.join(' / ')} errors: ${second.errors.join(' / ')}`);
    await second.close();

    // The summary request itself: the same getter the extension passes to the compactor.
    const config = loadConfig(profile);
    const summary = await createCompressor(new ModelRegistry(runtime), () => roleChoice(config, 'compactor')!, () => {})(
      { context: '0+1|user: hello\n', source: '0+1|user: hello', part: { l: 0, i: 0 } }, new AbortController().signal);
    assert.equal(summary, 'Summary.');
    assert.deepEqual(summarized, ['deep'], 'the summary request goes to the model Pi is on');
  } finally {
    for (const session of [...sessions]) await session.close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('a role with no saved pick follows the model Pi is on now', () => {
  // What the import dialog and its compactor ask for: a profile whose config.json has no compactor, subagent or main yet
  // (picks are only saved once one is made in Pi) still compresses on Pi's model instead of refusing.
  const pi: ModelChoice = { provider: 'fixture', model: 'plain', thinking: 'off' };
  assert.deepEqual(roleChoice(defaults, 'compactor', pi), pi);
  const main: ModelChoice = { provider: 'fixture', model: 'deep', thinking: 'low' };
  assert.deepEqual(roleChoice({ ...defaults, main }, 'compactor', pi), main, 'the pick saved at the last /model wins over the model Pi is on now');
  const pinned: ModelChoice = { provider: 'fixture', model: 'pinned', thinking: 'high' };
  assert.deepEqual(roleChoice({ ...defaults, main, compactor: pinned }, 'compactor', pi), pinned, 'and the compactor\'s own pick wins over both');
});
