import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type InlineExtension, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import * as sdk from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { allowSearch, SEARCH_DOC, VIEW_DOC } from './core/prompts.ts';
import { windowHandoff, CONNECTED, cutOffChildren, delegation, NO_DELEGATION, NOT_CONNECTED, RESTARTED, STEERABLE, SUBAGENT } from './prompts.ts';
import { memoryTools } from './tools.ts';
import { searchTool } from './core/tools.ts';
import { VIEW } from './core/memory.ts';
import type { Memory } from './memory.ts';
import type { ModelChoice } from './compactor.ts';
import { cachePayload } from './core/cache.ts';
import { childInput } from './core/messages.ts';
import { CUT_OFF, reportHead, RunHistory, isRunning, transition, sessionMessages, savedSession, undelivered, sentText, type Guidance, type RunInfo, type RunState, type FinishReason } from './runs.ts';
import { UsageLedger } from './usage.ts';
import { fullChat, refreshFraction, textContent } from './transcript.ts';
import { Type, type Static } from 'typebox';
import { result } from './core/tools.ts';
import { handoffText, withUndelivered, type HandoffEvidence } from './handoff.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';
import { THINKING } from './profiles.ts';
import { oneLine } from './inspector.ts';

export interface LiveRun {
  session: AgentSession; info: RunInfo; updated: number; streaming?: AgentMessage;
  tools: Map<string, { name: string; args: unknown; output?: unknown; started: number }>;
  pendingReports: string[]; pendingGuidance: Guidance[]; wake?: () => void; completion?: Promise<void>; primed?: Promise<unknown>;
  /** Set by the user's interrupt: the queued guidance the run continues with once its current step is aborted; with none, it pauses. */
  interruption?: Guidance[];
  /** Guidance just handed to session.prompt(): the next user message is it, as Pi may rewrite the text (a /skill: line becomes the skill). */
  prompting?: Guidance;
  /** Every steer into Pi's queue, one at a time, so each knows which queued text is its own (see `steer`). */
  steering: Promise<unknown>;
  /** Messages being steered back into Pi's queue after it was cleared; other queue changes wait for it. */
  requeueing?: Promise<void>;
  /** Shared by the children of one spawn whose reports are delivered together, in spawn order. */
  batch?: { ids: string[]; reports: Map<string, string> };
  /** Why stop() ended it; the first stop wins. Unset for a connected run: its handoff says how it ended, and it cannot be resumed. */
  stoppedBy?: StopCause;
}
/** `parent`: the agent that started it was stopped, or ended while it still worked. `pi`: Pi closed or reloaded while it was paused (working runs are cut off and resumed instead); a paused child whose parent still works gets `parent`, since close() stops that parent, which marks its descendants first. */
type StopCause = 'user' | 'parent' | 'pi';
// Said plainly: the aborted request's own error names no cause and reads as a failure.
const STOPPED: Record<StopCause, string> = {
  user: 'Stopped by the user. They ended it on purpose, so it did not fail: do not redo or delegate this task again unless they ask. Its chat is kept, so tell resumes it where it stopped.',
  parent: 'Stopped because the agent that started it stopped or ended. Its chat is kept, so tell resumes it where it stopped.',
  pi: 'Stopped because Pi closed or reloaded while it waited for the user. It is not resumed on its own; its chat is kept, so tell resumes it where it stopped.',
};
const stoppedReport = (cause: StopCause, text = '') => `${STOPPED[cause]}${text ? `\n\nIts last message before the stop:\n${text}` : ''}`;
interface Options { parentSession?: string; usage?: UsageLedger; createSession?: typeof createAgentSession;
  /** Names of the built-in extensions the main session loaded (see `loadedBuiltins`). */
  builtins?: () => Iterable<string>;
  /** Journals the reports a main-agent spawn has so far while its other children still run (none: the batch was delivered), so a crash cannot lose them. */
  hold?: (batch: string, texts: string[]) => void;
  /** Read on every spawn, so a changed profile setting applies to the next one. Missing settings take their defaults. */
  settings?: () => Partial<Settings>;
  /** The compactor's handoff, when the window can't write its own. */
  summarizeHandoff?: (run: RunInfo, messages: AgentMessage[], descendants?: HandoffEvidence[], signal?: AbortSignal) => Promise<string>;
  /** How long a window may take to write its handoff before the compactor writes it; 5 minutes by default. */
  windowHandoffTimeout?: number }

// Subagents load the user's installed extensions, except any copy of OptChat itself: they get memory tools directly and must not open a profile.
const packageName = (path: string): string | undefined => {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const data: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      return data && typeof data === 'object' && 'name' in data && typeof data.name === 'string' ? data.name : undefined;
    } catch { return undefined; } // A broken manifest is not OptChat's and must not block every spawn.
  }
};
/** A task's cwd may start with `~` and may be relative to the spawning agent's directory. */
export const taskDirectory = (cwd: string, path = '.', windows = process.platform === 'win32') =>
  resolve(cwd, path.replace(windows ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, homedir()));
const TITLE_DOC = 'Short label shown to the user, e.g. "Fix steering bug"';
const CWD_DOC = 'Project directory the subagent works in (~ allowed); its AGENTS.md files load from there. Defaults to your current directory.';
/** The spawn tools' tasks. What a task leaves out of model and thinking is the profile's subagent choice. */
export const TASKS = Type.Array(Type.Object({ task: Type.String(), title: Type.Optional(Type.String({ description: TITLE_DOC })), cwd: Type.Optional(Type.String({ description: CWD_DOC })),
  model: Type.Optional(Type.String({ description: 'Leave unset for the profile\'s subagent model (named in your instructions). Set only when the user asks for a model, as provider/id from models().' })),
  // A string enum, as Google's API and others accept; pi-ai's StringEnum is not typed for TypeBox since pi 1.5.
  thinking: Type.Optional(Type.Unsafe<ModelChoice['thinking']>({ type: 'string', enum: THINKING as unknown as string[],
    description: 'Leave unset for the profile\'s subagent level. Set only when the user asks for one.' })) }), { minItems: 1 });
export type Task = Static<typeof TASKS>[number];
/** The tool beside spawn that lists what a task's `model` may be. */
export const modelsTool = (children: () => Children) => ({ name: 'models', label: 'List models',
  description: 'The models a spawn task may name, as provider/id, with the profile\'s subagent default marked. provider narrows the list to one provider.',
  parameters: Type.Object({ provider: Type.Optional(Type.String()) }),
  execute: async (_id: string, args: { provider?: string }) => result(children().models(args.provider)) });
const isOptchat = (path: string) => packageName(path) === 'pi-optchat';

// Pi's CLI adds its built-in extensions (MCP, codemode, tool search) to its own session; SDK sessions such as
// subagents must add them. Pi versions that do not export a factory simply do not get that extension.
const BUILTINS: Record<string, string> = { mcp: 'createMcpExtension', codemode: 'createCodemodeExtension', 'tool-search': 'createToolSearchExtension' };
const PREFIX = 'builtin:';
/** The built-in extensions a session loaded: `--no-mcp`, `-builtin:<name>` settings and replacing extensions leave them out. */
export const loadedBuiltins = (pi: Pick<ExtensionAPI, 'getCommands' | 'getAllTools'>) => new Set([...pi.getCommands(), ...pi.getAllTools()]
  .map(item => item.sourceInfo?.path ?? '').filter(path => path.startsWith(PREFIX) && Object.hasOwn(BUILTINS, path.slice(PREFIX.length))).map(path => path.slice(PREFIX.length)));
/** Fresh built-in extensions for one session, as `builtin:<name>` resources, so the session's own settings still apply. */
export const builtinExtensions = (names: Iterable<string>): InlineExtension[] => [...new Set(names)].flatMap(name => {
  const create = Object.hasOwn(BUILTINS, name) ? (sdk as unknown as Record<string, unknown>)[BUILTINS[name]] : undefined;
  return typeof create === 'function' ? [{ name, factory: create(), replaceable: true, builtin: true }] : [];
});
/** Subagent transcripts are never summarized into the memory tree, so the mid-turn view refresh can't cover them; we rely on
 * Pi's built-in compaction instead, set to start at about the main agent's Turn refresh threshold: that share of the window on top of the
 * view in the task. If subagent quality drops after compaction, look into giving subagents their own summary tree (same refresh
 * as the main agent) or a hybrid: Pi compaction plus a zoomable summarized transcript. With the threshold off, Pi's default applies. */
export function subagentCompaction(contextWindow: number, fraction: number) {
  if (!(fraction > 0)) return { enabled: true };
  return { enabled: true, reserveTokens: Math.max(16_384, Math.round(contextWindow * (1 - fraction) - VIEW / 4)) };
}
/** Waits for `promise`, or until `signal` aborts. */
async function abortable(promise: Promise<unknown>, signal?: AbortSignal) {
  let stop = () => {};
  const aborted = new Promise<void>(resolve => { stop = resolve; });
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try { await Promise.race([promise, aborted]); } finally { signal?.removeEventListener('abort', stop); }
}
/** Resolves once the session's model starts answering, or its request ends without an answer. */
const answering = (session: AgentSession) => new Promise<void>(resolve => {
  const off = session.subscribe(event => {
    if (event.type === 'message_update' || event.type === 'agent_end' || event.type === 'message_end' && event.message.role === 'assistant') { off(); resolve(); }
  });
});

/** What a run interrupted with messages queued continues with: the user's interrupt, so windows show it as theirs. */
export const INTERRUPTED = 'Interrupted by the user:\n\n';
const interruptedWith = (texts: string[]) => `${INTERRUPTED}${texts.join('\n\n')}`;

/** Pi reads AGENTS.md/CLAUDE.md only at session start and /reload. Re-reading the files Pi loaded picks up edits each run and keeps
 * the session's own choices (`-nc`, its agent dir); a file that can't be read is skipped, as Pi does. A new file still needs /reload. */
export function refreshContextFiles(options: { contextFiles: Array<{ path: string; content: string }> }) {
  options.contextFiles = options.contextFiles.flatMap(({ path }) => { try { return [{ path, content: readFileSync(path, 'utf8') }]; } catch { return []; } });
}
export class Children {
  private readonly running = new Map<string, LiveRun>();
  readonly history: RunHistory;
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private launching = 0;
  private readonly resuming = new Set<string>();
  private readonly deleting = new Set<string>();
  private settling = 0;
  private readonly launches = new Set<Promise<unknown>>();
  private readonly completions = new Set<Promise<void>>();
  /** Aborted when Pi starts closing: see deferHandoffs(). */
  private readonly deferring = new AbortController();
  constructor(private readonly memory: Memory, private readonly registry: ModelRegistry,
    private readonly choice: () => ModelChoice, private readonly instructions: () => string,
    private readonly report: (text: string, options?: { once?: boolean; count?: number }) => Promise<void>, private readonly warn: (text: string) => void,
    private readonly profileDirectory = memory.directory, private readonly options: Options = {}) {
    this.history = new RunHistory(profileDirectory);
    for (const warning of this.history.warnings) warn(warning);
    for (const run of this.history.records.values()) {
      if (!run.sessionFile || !options.usage) continue;
      try {
        const manager = SessionManager.open(run.sessionFile);
        options.usage.backfill(manager.getEntries(), run.parentSession, 'subagent', run.id);
      } catch (error) { warn(`Could not backfill child usage for ${run.id}: ${String(error)}`); }
    }
  }
  private get settings(): Settings { return { ...DEFAULT_SETTINGS, ...this.options.settings?.() }; }
  private full(extra: number) { return this.running.size + this.launching + extra > this.settings.maxAgents; }
  /** A model named `provider/id`, as runs record it. */
  /** The models a task may name, one `provider/id` per line: every model Pi is logged in to, the profile's subagent choice marked. */
  models(provider?: string) {
    const profile = this.choice(), fallback = `${profile.provider}/${profile.model}`;
    const available = this.registry.getAvailable();
    const names = available.filter(m => !provider || m.provider === provider).map(m => `${m.provider}/${m.id}`).sort();
    if (!names.length) throw new Error(provider ? `No models for provider ${provider}. Providers: ${[...new Set(available.map(m => m.provider))].sort().join(', ') || 'none'}.` : 'No models available.');
    return names.map(name => name === fallback ? `${name}  (subagent default, thinking ${profile.thinking})` : name).join('\n');
  }
  private find(name: string) { const slash = name.indexOf('/'); return slash > 0 ? this.registry.find(name.slice(0, slash), name.slice(slash + 1)) : undefined; }
  get ids() { return [...this.running.keys()]; }
  get active() { return this.completions.size > 0 || this.launching > 0 || this.settling > 0; }
  live(id: string) { return this.running.get(id); }
  collectUsage() {
    for (const live of this.running.values()) this.options.usage?.backfill(live.session.sessionManager.getEntries(), live.info.parentSession, 'subagent', live.info.id);
  }
  messages(id: string): AgentMessage[] {
    const live = this.running.get(id);
    if (live) return [...live.session.messages, ...(live.streaming ? [live.streaming] : [])];
    const file = this.history.records.get(id)?.sessionFile;
    return file ? sessionMessages(file) : [];
  }
  /**
   * Every message a run has finalized, in order and never rewritten: Pi's session entries, for a live run too.
   * `session.messages` is only the model's projection, which compaction and retries replace with a shorter list.
   */
  retained(id: string): AgentMessage[] {
    const live = this.running.get(id);
    return live ? live.session.sessionManager.getEntries().flatMap(e => e.type === 'message' ? [e.message] : []) : this.messages(id);
  }
  /** A run's messages for zoom, live or finished; undefined for no such run. A subagent `reader` sees only its own descendants, as with tell. */
  transcript(id: string, reader?: string) {
    const known = reader ? this.history.descendants(reader).some(run => run.id === id) : this.running.has(id) || this.history.records.has(id);
    if (!known) return undefined;
    const live = this.running.get(id);
    if (!live) return this.messages(id);
    const retained = this.retained(id);
    // Pi puts the finalized message in session.messages before message_end listeners run, then persists that same object.
    const tail = live.streaming ?? live.session.messages.at(-1);
    return tail && !retained.includes(tail) ? [...retained, tail] : retained;
  }
  /** Runs at work now: running, waiting for children, or stopping; not paused. */
  get working() { return [...this.running.values()].filter(live => isRunning(live.info)).map(live => live.info); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private save(info: RunInfo) { this.history.save(info); this.changed(); }
  private observe(live: LiveRun, event: AgentSessionEvent) {
    try {
      live.updated = Date.now();
      if (event.type === 'message_update') live.streaming = event.message;
      if (event.type === 'message_end') {
        live.streaming = undefined;
      }
      if (event.type === 'turn_end' || event.type === 'agent_settled') this.options.usage?.backfill(live.session.sessionManager.getEntries(), live.info.parentSession, 'subagent', live.info.id);
      if (event.type === 'message_start' && event.message.role === 'user') {
        const text = textContent(event.message.content);
        const guidance = live.prompting ?? live.info.guidance.find(g => g.state === 'queued' && sentText(g) === text);
        live.prompting = undefined;
        if (guidance) { if (text !== guidance.text) guidance.sent = text; guidance.state = 'delivered'; this.save(live.info); }
      }
      if (event.type === 'tool_execution_start') live.tools.set(event.toolCallId, { name: event.toolName, args: event.args, started: Date.now() });
      if (event.type === 'tool_execution_update') {
        const tool = live.tools.get(event.toolCallId); if (tool) tool.output = event.partialResult;
      }
      if (event.type === 'tool_execution_end') live.tools.delete(event.toolCallId);
      this.changed();
    } catch (error) { this.warn(`Could not record subagent activity: ${String(error)}`); }
  }
  async spawn(tasks: Task[], cwd: string, signal?: AbortSignal, parentId?: string, connected = false) {
    return (await this.launch(tasks, cwd, signal, parentId, connected)).ids;
  }
  /** The spawn tools' answer, saying how this spawn's reports will come back. */
  async start(tasks: Task[], cwd: string, signal?: AbortSignal, parentId?: string) {
    const { ids, grouped } = await this.launch(tasks, cwd, signal, parentId);
    return `Started: ${ids.join(', ')}. ${grouped && ids.length > 1 ? 'Their reports will arrive together, as one message, once all of them have finished.' : 'Reports will arrive automatically.'}`;
  }
  private async launch(tasks: Task[], cwd: string, signal: AbortSignal | undefined, parentId: string | undefined, connected = false) {
    for (const directory of tasks.map(t => taskDirectory(cwd, t.cwd))) if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`No such directory: ${directory}`);
    const profile = this.choice();
    const runs = tasks.map(task => {
      const name = task.model ?? `${profile.provider}/${profile.model}`, model = this.find(name);
      // Like Pi's own setModel: a named model needs auth, so a guess at a provider the user isn't logged in to fails here, not in the child.
      if (!model || task.model && !this.registry.hasConfiguredAuth(model)) throw new Error(`Subagent model unavailable: ${name}. Models you can use: ${this.registry.getAvailable().map(m => `${m.provider}/${m.id}`).join(', ') || 'none'}.`);
      return { ...task, model, thinking: task.thinking ?? profile.thinking };
    });
    if (this.closing) throw new Error('Profile is closing.');
    this.settling++;
    try { await this.memory.settle(signal); } finally { this.settling--; }
    const parent = parentId ? this.running.get(parentId) : undefined;
    const cancelled = () => this.closing || (parentId !== undefined && this.running.get(parentId)?.info.state !== 'running');
    if (parentId && (!parent || parent.info.state !== 'running')) throw new Error('The parent is no longer running.');
    const depth = parent ? parent.info.depth + 1 : 1;
    const { subagentLevels, maxAgents, groupReports } = this.settings;
    if (depth > subagentLevels) throw new Error(`Delegation depth limit reached: this profile allows ${subagentLevels} level${subagentLevels === 1 ? '' : 's'} of subagents.`);
    if (this.closing) throw new Error('Profile is closing.');
    if (this.full(tasks.length)) throw new Error(`Profile limit: at most ${maxAgents} active agents, including parents and descendants. Reduce the batch or continue without delegating.`);
    const view = this.memory.render();
    const launched = await this.track(this.launchBatch({ tasks: runs, cwd, depth, parentId, connected, signal, cancelled }));
    // Grouped, the last child of this spawn to finish delivers every report; otherwise each reports on its own.
    const batch = groupReports && !connected ? { ids: launched.map(c => c.info.id), reports: new Map<string, string>() } : undefined;
    // Siblings on one model and directory send the same system prompt, tools and view. Anthropic can't read a cache entry
    // still being written, so their first requests wait until the first sibling starts answering and read its entry instead.
    const [first] = launched, answered = launched.length > 1 && first.session.model?.api === 'anthropic-messages' ? answering(first.session) : undefined;
    for (const live of launched) {
      live.batch = batch;
      const work = this.execute(live, childInput({ view, task: live.info.task })).catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      if (live === first && answered) for (const sibling of launched.slice(1)) if ((['model', 'thinking', 'cwd'] as const).every(k => sibling.info[k] === first.info[k])) sibling.primed = Promise.race([answered, work]);
      this.completions.add(work);
      live.completion = work;
    }
    this.changed();
    return { ids: launched.map(c => c.info.id), grouped: batch !== undefined };
  }
  /** close() waits for launches, so shutdown never unlocks the profile under a child that is still opening. */
  private track<T>(launch: Promise<T>) {
    this.launches.add(launch);
    const done = () => { this.launches.delete(launch); };
    launch.then(done, done);
    return launch;
  }
  private async launchBatch({ tasks, cwd, depth, parentId, connected, signal, cancelled }: { tasks: (Omit<Task, 'model' | 'thinking'> & { model: Model<Api>; thinking: ModelChoice['thinking'] })[]; cwd: string; depth: number;
    parentId?: string; connected: boolean; signal?: AbortSignal; cancelled: () => boolean }) {
    const launched: LiveRun[] = [];
    let reserved = tasks.length;
    this.launching += reserved;
    try {
      for (const task of tasks) {
        signal?.throwIfAborted();
        if (cancelled()) throw new Error('Parent or profile is stopping.');
        const id = randomUUID().slice(0, 8), directory = taskDirectory(cwd, task.cwd);
        const session = await this.open({ id, directory, depth, parentId, connected, model: task.model, thinking: task.thinking,
          sessionManager: SessionManager.create(directory, join(this.profileDirectory, 'runs')) });
        // One short line without brackets, so the `[id · title]` head of its reports stays parseable and small.
        const title = oneLine(task.title ?? '').replace(/[[\]]/g, '').trim().slice(0, 128).trimEnd();
        const info: RunInfo = { id, task: task.task, ...(title ? { title } : {}), cwd: directory, model: `${task.model.provider}/${task.model.id}`, thinking: session.thinkingLevel,
          parentSession: this.options.parentSession ?? '', parentId, depth, sessionFile: session.sessionFile, started: Date.now(), state: 'running', guidance: [], ...(connected ? { connected: true } : {}) };
        const live: LiveRun = { session, info, updated: Date.now(), tools: new Map(), pendingReports: [], pendingGuidance: [], steering: Promise.resolve() };
        launched.push(live); this.save(info); this.running.set(id, live);
        this.launching--; reserved--;
        session.subscribe(event => this.observe(live, event));
        signal?.throwIfAborted();
        if (cancelled()) throw new Error('Parent or profile is stopping.');
      }
    } catch (error) {
      for (const child of launched) {
        await this.shutdown(child.session); // Extensions such as MCP close their connections and stop their server processes.
        this.dispose(child.session); this.running.delete(child.info.id);
        transition(child.info, 'failed'); child.info.ended = Date.now(); child.info.report = `Launch failed: ${String(error)}`;
        if (child.info.connected) child.info.handoff = { reason: signal?.aborted ? 'disconnected' : 'failed' };
        this.save(child.info);
        if (child.info.connected) await this.deliverHandoff(child.info).catch(error => this.warn(`Handoff saved for recovery: ${String(error)}`));
      }
      throw error;
    } finally { this.launching -= reserved; }
    return launched;
  }
  /** Builds a child session with the same prompt, tools and extensions whether it is new or resumed. */
  private async open(o: { id: string; directory: string; depth: number; parentId?: string; connected: boolean; model: Model<Api>;
    thinking?: ModelChoice['thinking']; sessionManager: SessionManager }) {
    const { id, directory, depth, parentId, connected } = o;
    const { subagentLevels, maxAgents, memorySearch } = this.settings, delegates = depth < subagentLevels;
    // The user's settings list their installed packages; a copy in memory keeps the child from writing them back.
    const settingsManager = SettingsManager.inMemory({ ...SettingsManager.create(directory, getAgentDir()).getSettings(),
      compaction: subagentCompaction(o.model.contextWindow, refreshFraction(this.settings.refreshAt)), cacheWarming: 'off' });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: getAgentDir(), settingsManager,
      noPromptTemplates: true,
      extensionsOverride: base => ({ ...base, extensions: base.extensions.filter(e => !isOptchat(e.resolvedPath)) }),
      extensionFactories: [...builtinExtensions(this.options.builtins?.() ?? []), pi => {
        const provider = this.registry.getRegisteredProviderConfig(o.model.provider);
        if (provider) pi.registerProvider(o.model.provider, provider);
        // Same prompt as the main agent (AGENTS.md files, skills, cwd); only the OptChat preamble differs.
        // Read every run, so edits reach a live child's next run (after a pause, or a connected window's next message); Pi sends only the changed sections.
        pi.on('before_agent_start', event => {
          event.systemPromptOptions.customPrompt = allowSearch(`${SUBAGENT}\n\n${VIEW_DOC}${memorySearch ? SEARCH_DOC : ''}`, memorySearch);
          event.systemPromptOptions.sections.instructions = [this.instructions(), delegates ? delegation(maxAgents, this.choice()) : NO_DELEGATION, STEERABLE, connected ? CONNECTED : NOT_CONNECTED].filter(Boolean).join('\n\n');
          refreshContextFiles(event.systemPromptOptions);
        });
        pi.on('before_provider_request', async (event, ctx) => {
          // Set by launch for a sibling's first request; a stop or an interrupt aborts the request, which ends the wait.
          const live = this.running.get(id), primed = live?.primed;
          if (live && primed) { live.primed = undefined; await abortable(primed, ctx.signal); }
          return ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload;
        });
      }],
    });
    await loader.reload();
    const { session } = await (this.options.createSession ?? createAgentSession)({ cwd: directory, resourceLoader: loader, settingsManager,
      model: o.model, thinkingLevel: o.thinking, sessionManager: o.sessionManager,
      customTools: [...memoryTools(() => this.memory, run => this.transcript(run, id)), ...(memorySearch ? [searchTool(() => this.memory)] : []), ...(delegates ? [...this.delegationTools(id, directory, subagentLevels, maxAgents), modelsTool(() => this)] : []), this.parentTool(id, parentId, connected)],
      excludeTools: delegates ? [] : ['spawn', 'tell', 'models'],
    });
    // Callers track the session only after this returns: clean up here if its extensions fail to start.
    try { await session.bindExtensions({}); }
    catch (error) { await this.shutdown(session); this.dispose(session); throw error; }
    return session;
  }
  private delegationTools(parentId: string, cwd: string, levels: number, maxAgents: number) {
    return [{ name: 'spawn', label: 'Delegate task', description: `Delegate parts of your task. Results arrive automatically after this run; never poll or sleep waiting. models() lists the ids a task's model may name. Maximum depth ${levels} and ${maxAgents} active agents per profile.`,
      parameters: Type.Object({ tasks: TASKS }),
      execute: async (_id: string, args: { tasks: Task[] }, signal?: AbortSignal) => result(await this.start(args.tasks, cwd, signal, parentId)),
    }, { name: 'tell', label: 'Guide child', description: 'Send guidance to one of your direct children. A finished child is resumed with its earlier conversation, and its new report arrives automatically.',
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id: string, args: { id: string; message: string }) => {
        if (this.history.records.get(args.id)?.parentId !== parentId) throw new Error('You can only guide your own children.');
        return result(await this.tell(args.id, args.message, 'manager', parentId));
      },
    }];
  }
  /** Lets a child message its parent mid-run, the way tell lets the parent guide it. */
  private parentTool(id: string, parentId: string | undefined, connected: boolean) {
    return { name: 'tell_parent', label: parentId ? 'Message parent agent' : 'Message main agent',
      description: `Send ${parentId ? 'your parent agent' : 'the main agent'} a question or important finding while you keep working. Its reply can arrive as guidance; continue useful work instead of polling. Your final answer is delivered automatically.`,
      parameters: Type.Object({ message: Type.String() }), execute: async (_id: string, args: { message: string }) => {
        const message = args.message.trim();
        if (!message) throw new Error('Message is empty.');
        const text = `${reportHead(this.history.records.get(id) ?? { id })} ${connected ? 'Connected agent message' : 'Message from subagent (still running)'}: ${message}`;
        if (!await this.toParent(parentId, text)) throw new Error('Your parent is no longer running.');
        return result(parentId ? `Message sent to parent ${parentId}.` : 'Message sent to the main agent.');
      },
    };
  }
  /** A mid-run message to a child's parent: false if that parent is no longer running. */
  private async toParent(parentId: string | undefined, text: string) {
    if (!parentId) { await this.report(text); return true; }
    const parent = this.running.get(parentId);
    if (!parent || !['running', 'waiting', 'paused'].includes(parent.info.state)) return false;
    if (parent.info.state === 'running') await this.steer(parent, text);
    else { parent.pendingReports.push(text); parent.wake?.(); } // A paused parent keeps it until the user resumes it.
    this.changed();
    return true;
  }
  private async shutdown(session: AgentSession) {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private dispose(session: AgentSession) {
    try { session.dispose(); } catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private directChildren(id: string) { return [...this.running.values()].filter(c => c.info.parentId === id); }
  private async execute(live: LiveRun, prompt: string) {
    const { session, info } = live;
    try {
      if (info.connected) await this.report(`[${info.id}] User started a connected conversation in ${info.cwd}. That agent is handling this request with the user directly; don't do it yourself. Initial message: ${info.task}\n\nUse tell with this agent ID only if you know something it needs. It stays open between replies and sends a final handoff on completion or disconnect.`);
      // A stop that lands before the first prompt has no turn to abort, so it is honoured here.
      const state: RunState = info.state; // a local, so the loop below still sees later state changes
      if (this.closing || info.handoff || state === 'stopping') throw new Error('Stopped before its first request.');
      await session.prompt(prompt);
      while (info.state !== 'stopping') {
        if (live.interruption) {
          // A message Pi took during the abort (a rebuild of its queue can still be landing) went into a request the abort
          // cancelled, so it got no reply: it goes in this prompt too. Only a stop's undelivered ones stay out.
          const guidance = live.interruption.filter(g => g.state !== 'undelivered');
          // Read Pi's queue only once a rebuild has landed, and take the interrupt's messages off it so they arrive once.
          // Until this is done, tell() holds new messages in pendingGuidance, where the turn below or a pause picks them up.
          await live.requeueing;
          const texts = new Set(guidance.map(sentText));
          await this.requeue(live, session.clearQueue().steering.filter(text => !texts.has(text)));
          live.interruption = undefined;
          if (!guidance.length) {
            // Nothing to hand over: the run waits for its next message instead of ending, and whoever waits on its report hears why.
            if (transition(info, 'paused')) {
              this.save(info);
              // In a grouped spawn the note takes the run's place, so its siblings' reports are not held until the user comes back; its later report arrives on its own.
              const note = `${reportHead(info)} Interrupted by the user; it waits for their next message, so no report until then.`, batch = live.batch;
              live.batch = undefined;
              if (!info.connected) await (batch ? this.deliver(info, batch, note) : this.toParent(info.parentId, note))
                .catch(error => this.warn(`Could not tell the parent about the interrupt: ${String(error)}`));
            }
            continue;
          }
          if (!transition(info, 'running')) continue; // A stop during the cleanup wins.
          for (const g of guidance) g.state = 'delivered';
          this.save(info);
          await session.prompt(interruptedWith(guidance.map(sentText)));
          continue;
        }
        const paused = info.state === 'paused';
        if (paused && !live.pendingGuidance.length) {
          await new Promise<void>(resolve => { live.wake = resolve; }); live.wake = undefined;
          continue;
        }
        const last = session.messages.findLast(m => m.role === 'assistant');
        // An error ends the turn, not the run: children still at work report to it and it answers them, as the main agent does.
        if (!paused && last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted') && !live.pendingReports.length && !this.directChildren(info.id).length) break;
        if (live.pendingGuidance.length) {
          transition(info, 'running'); this.save(info);
          live.prompting = live.pendingGuidance.shift()!;
          // An extension command sends no message at all, so this can't outlive the prompt and claim a later one.
          try { await session.prompt(live.prompting.text); } finally { live.prompting = undefined; }
          continue;
        }
        if (live.pendingReports.length) {
          transition(info, 'running'); this.save(info);
          await session.prompt(live.pendingReports.splice(0).join('\n\n'));
          continue;
        }
        const children = this.directChildren(info.id).flatMap(child => child.completion ? [child.completion] : []);
        if (!children.length && !info.connected) break;
        const wake = new Promise<void>(resolve => { live.wake = resolve; });
        transition(info, 'waiting'); this.save(info);
        await Promise.race([...children, wake]); live.wake = undefined;
      }
      const last = session.messages.findLast(m => m.role === 'assistant');
      transition(info, info.state === 'stopping' || last?.role === 'assistant' && last.stopReason === 'aborted' ? 'stopped'
        : last?.role === 'assistant' && last.stopReason === 'error' ? 'failed' : 'completed');
      const text = session.getLastAssistantText();
      info.report = info.state === 'stopped' && live.stoppedBy ? stoppedReport(live.stoppedBy, text)
        : last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted') ? `Task ${last.stopReason}: ${last.errorMessage ?? 'No details'}` : text || 'Finished without a text report.';
    } catch (error) {
      transition(info, info.state === 'stopping' ? 'stopped' : 'failed');
      info.report = info.state === 'stopped' && live.stoppedBy ? stoppedReport(live.stoppedBy, session.getLastAssistantText()) : `${info.state}: ${String(error)}`;
    } finally {
      const children = this.directChildren(info.id);
      await Promise.allSettled(children.map(child => this.stop(child.info.id, 'parent')));
      await Promise.allSettled(children.flatMap(child => child.completion ? [child.completion] : []));
      info.ended = Date.now();
      for (const g of info.guidance) if (g.state === 'queued') g.state = 'undelivered';
      // A connected run hands off while its session is still open, since the window writes its own handoff. Its session is shut down only here.
      try {
        if (info.connected) {
          info.handoff ??= { reason: 'failed' };
          // Pi's queue must be empty before the handoff turn, or it would take a cancelled message as new input. Guidance in it is
          // already marked undelivered; the rest (a child's message) joins the reports the window never read.
          await live.requeueing;
          const guidance = new Set(info.guidance.map(sentText));
          const unread = [...live.pendingReports.splice(0), ...session.clearQueue().steering.filter(text => !guidance.has(text))];
          if (unread.length) info.handoff.unread = unread;
          transition(info, info.handoff.reason === 'complete' ? 'completed' : 'interrupted');
          this.save(info);
          await this.deliverHandoff(info, session);
        }
      } finally {
        await this.shutdown(session);
        // A failed dispose must neither keep the slot taken nor drop the report below.
        this.dispose(session); this.running.delete(info.id);
      }
    }
    if (info.cutOff) {
      // Aborted by Pi closing, not by anyone's choice: no report now, the next start resumes it.
      if (info.state === 'stopped' && transition(info, 'interrupted')) { info.report = CUT_OFF; this.save(info); return; }
      delete info.cutOff; // It finished on its own while Pi was closing.
    }
    // Its cut-off children were named to it when it was resumed; having ended on its own, it no longer will resume them.
    if (!this.closing) for (const run of this.history.descendants(info.id)) if (run.cutOff) { delete run.cutOff; this.save(run); }
    if (info.connected) return; // It handed off above.
    // Said plainly, so the parent does not take the user's choice for a failure and delegate the task again.
    if (this.deleting.has(info.id)) info.report = 'Deleted by the user while it was working. The user dropped this task on purpose: do not redo it or delegate it again unless they ask.';
    // A metadata failure must not suppress delivery of the actual result.
    try { this.save(info); } catch (error) { this.warn(`Could not save run metadata: ${String(error)}`); }
    // A deleted run's transcript is gone.
    await this.deliver(info, live.batch, `${reportHead(info)} ${info.report}${this.deleting.has(info.id) ? '' : `\n\n${fullChat(info.id)}`}`);
  }
  /** Sends a run's report to its parent; in a grouped spawn, only once every child of the spawn has one. */
  private async deliver(info: RunInfo, batch: LiveRun['batch'], text: string) {
    let count: number | undefined;
    if (batch) {
      batch.reports.set(info.id, text);
      const texts = batch.ids.flatMap(id => batch.reports.get(id) ?? []);
      if (texts.length < batch.ids.length) { if (!info.parentId) this.options.hold?.(batch.ids[0], texts); return; }
      text = texts.join('\n\n'); count = texts.length;
    }
    if (info.parentId) {
      const parent = this.running.get(info.parentId);
      // A connected parent that is ending still keeps the reports of children that finished on their own: its handoff includes
      // them. Its stopped children are named there instead.
      const finished = (batch?.ids ?? [info.id]).filter(id => ['completed', 'failed'].includes(this.history.records.get(id)?.state ?? ''))
        .map(id => batch?.reports.get(id) ?? text);
      const ending = parent?.info.state === 'stopping' || parent?.info.state === 'stopped';
      const kept = !ending ? text : parent?.info.connected && finished.length ? finished.join('\n\n') : undefined;
      if (parent && kept) { parent.pendingReports.push(kept); parent.wake?.(); this.changed(); }
      return;
    }
    if (this.closing) this.memory.append('work', text);
    else try { await this.report(text, { count }); }
    catch (error) {
      this.memory.append('work', text);
      this.warn(`Subagent report saved but could not wake the parent: ${String(error)}`);
    }
    if (batch && batch.ids.length > 1) this.options.hold?.(batch.ids[0], []);
  }
  /** `caller` is the agent sending a manager message: undefined for the main agent, else the parent subagent's ID. */
  async tell(id: string, message: string, source: 'manager' | 'user' = 'manager', caller?: string) {
    if (this.deleting.has(id)) throw new Error(`${id} is being deleted by the user.`);
    const live = this.running.get(id);
    if (!live && source === 'manager' && this.history.records.has(id)) return this.track(this.resume(id, message, caller));
    if (live && !['running', 'waiting', 'paused'].includes(live.info.state)) throw new Error(`${id} is finishing. Its report will arrive on its own${live.info.connected || source === 'user' ? '' : '; tell it again after that to resume it'}.`);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const text = live.info.connected && source === 'manager' ? `[Main agent guidance]\n${message.trim()}` : message.trim(); if (!message.trim()) throw new Error('Message is empty.');
    if (source === 'user') this.memory.append('user', `Direct guidance to subagent [${id}]: ${text}`);
    const guidance: Guidance = { text, date: Date.now(), state: 'queued', from: source };
    live.info.guidance.push(guidance); this.save(live.info);
    try {
      await live.requeueing; // Keeps the queue in the order messages were sent.
      if (live.info.state === 'running' && !live.interruption) {
        const sent = await this.steer(live, text);
        if (sent !== undefined && sent !== text) guidance.sent = sent;
      } else { live.pendingGuidance.push(guidance); live.wake?.(); } // Waiting, paused or being interrupted: this message starts its next turn.
    }
    catch (error) { guidance.state = 'undelivered'; this.save(live.info); throw error; }
    if (guidance.state === 'undelivered') throw new Error(`${id} finished before it read the message. Tell it again to resume it.`);
    return 'Message queued for the next tool boundary.';
  }
  /**
   * The user's Ctrl+C, never destructive: aborts the current step. With guidance queued, the run continues at once with it;
   * with none, it pauses until the next message (from the user or a tell). Only stop() ends a run.
   */
  async interrupt(id: string): Promise<'continued' | 'paused'> {
    const live = this.running.get(id);
    if (live?.info.state === 'paused') return 'paused';
    if (!live || !['running', 'waiting'].includes(live.info.state)) throw new Error(`No running subagent ${id}.`);
    const guidance = live.info.guidance.filter(g => g.state === 'queued');
    // Nothing yields before the abort starts, so the run cannot finish in between and drop the messages.
    // They leave pendingGuidance and Pi's steering queue here, and execute() sends them in one prompt. Pi's queue must be empty
    // before the abort: after an aborted tool call Pi hands it to a request the abort cancels.
    live.pendingGuidance = live.pendingGuidance.filter(g => !guidance.includes(g));
    const texts = new Set(guidance.map(sentText));
    // The rest of the queue (a child's tell_parent message) follows the interrupt's prompt, as reports to a paused run do.
    live.pendingReports.push(...live.session.clearQueue().steering.filter(text => !texts.has(text)));
    live.interruption = guidance;
    live.wake?.();
    await live.session.abort();
    return guidance.length ? 'continued' : 'paused';
  }
  /** Takes the user's newest undelivered message back off the queue, to edit it; undefined when there is none left to take. */
  withdraw(id: string) {
    const live = this.running.get(id);
    const text = live?.info.guidance.findLast(g => g.state === 'queued' && g.from === 'user')?.text;
    if (!live || text === undefined || live.requeueing || live.interruption) return undefined;
    // The queue holds only texts, so of equal ones the last is taken back, record and queue entry alike.
    const guidance = live.info.guidance.findLast(g => g.state === 'queued' && g.text === text)!;
    const pending = live.pendingGuidance.indexOf(guidance);
    if (pending >= 0) live.pendingGuidance.splice(pending, 1);
    else {
      const steering = live.session.getSteeringMessages();
      const at = steering.lastIndexOf(sentText(guidance));
      if (at < 0) return undefined; // Already on its way to the agent.
      // Pi cannot drop a single queued message: clear the queue and steer the rest back in order.
      void this.requeue(live, live.session.clearQueue().steering.filter((_, i) => i !== at));
    }
    live.info.guidance.splice(live.info.guidance.indexOf(guidance), 1); this.save(live.info);
    return guidance.text;
  }
  /** Pi's steer(), returning what Pi queued, which may differ from `text` (a /skill: line becomes the skill): that is what the agent receives. */
  private steer(live: LiveRun, text: string) {
    // One at a time, so the newest entry in Pi's queue is this one's.
    const sent = live.steering.then(async () => await live.session.steer(text) === 'queued' ? live.session.getSteeringMessages().at(-1) : undefined);
    live.steering = sent.catch(() => undefined);
    return sent;
  }
  private requeue(live: LiveRun, texts: string[]) {
    const work: Promise<void> = (async () => {
      try { for (const text of texts) await this.steer(live, text); }
      catch (error) { this.warn(`Could not requeue a message for ${live.info.id}: ${String(error)}`); }
    })().finally(() => { if (live.requeueing === work) live.requeueing = undefined; });
    live.requeueing = work;
    return work;
  }
  /** Reopens a finished child from its saved transcript, same ID, parent and model, and gives it a new message. */
  private async resume(id: string, message: string, caller: string | undefined) {
    const run = this.history.records.get(id)!, text = message.trim();
    if (!text) throw new Error('Message is empty.');
    if (run.connected) throw new Error(`${id} was a connected conversation with the user. It has ended and its handoff was delivered, so it cannot be resumed. Spawn a new subagent instead.`);
    if (!['completed', 'failed', 'stopped', 'interrupted'].includes(run.state) || this.resuming.has(id)) throw new Error(`${id} is still finishing. Its report will arrive on its own.`);
    if (run.parentId !== caller) {
      if (!run.parentId) throw new Error(`Only the main agent can resume ${id}.`);
      const parent = this.running.get(run.parentId);
      throw new Error(parent && ['running', 'waiting', 'paused'].includes(parent.info.state) ? `Only ${id}'s parent ${run.parentId} can resume it. Ask ${run.parentId} with tell.`
        : `Only ${id}'s parent ${run.parentId} can resume it, and that parent is no longer running. Resume ${run.parentId} instead, or spawn a new subagent.`);
    }
    if (this.closing) throw new Error('Profile is closing.');
    if (this.full(1)) throw new Error(`Profile limit: at most ${this.settings.maxAgents} active agents, including parents and descendants. ${id} can be resumed when one finishes.`);
    const manager = savedSession(run);
    if (!manager?.getEntries().some(e => e.type === 'message')) throw new Error(`The saved transcript of ${id} is missing or unreadable, so it cannot be resumed. Spawn a fresh subagent and give it the context it needs.`);
    if (!existsSync(run.cwd) || !statSync(run.cwd).isDirectory()) throw new Error(`${id}'s directory ${run.cwd} no longer exists, so it cannot be resumed. Spawn a fresh subagent instead.`);
    const model = this.find(run.model);
    if (!model) throw new Error(`${id}'s model ${run.model} is not available, so it cannot be resumed. Spawn a fresh subagent instead.`);
    this.launching++; this.resuming.add(id);
    let reserved = true;
    try {
      // No thinking level: the session restores the one it ran with.
      const session = await this.open({ id, directory: run.cwd, depth: run.depth, parentId: run.parentId, connected: false, model, sessionManager: manager });
      // stop() cannot see this child until it is registered, so a parent stopped meanwhile must cancel it here.
      const parent = run.parentId ? this.running.get(run.parentId) : undefined;
      if (this.closing || run.parentId && (!parent || !['running', 'waiting', 'paused'].includes(parent.info.state))) {
        await this.shutdown(session); this.dispose(session); throw new Error('Parent or profile is stopping.');
      }
      // The finished record stays untouched (and resumable) unless the new one is saved.
      const { ended: _ended, cutOff: _cutOff, ...rest } = run;
      const cut = [...this.history.records.values()].filter(r => r.parentId === id && r.cutOff).map(r => r.id);
      const prompt = cutOffChildren(text, cut);
      const info: RunInfo = { ...rest, state: 'running', started: Date.now(), parentSession: this.options.parentSession ?? run.parentSession,
        guidance: [...run.guidance, { text: prompt, date: Date.now(), state: 'queued', from: 'manager' }] };
      try { this.save(info); } catch (error) { this.history.records.set(id, run); await this.shutdown(session); this.dispose(session); throw error; }
      const live: LiveRun = { session, info, updated: Date.now(), tools: new Map(), pendingReports: [], pendingGuidance: [], steering: Promise.resolve() };
      this.running.set(id, live);
      this.launching--; reserved = false;
      session.subscribe(event => this.observe(live, event));
      const work = this.execute(live, prompt).catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      this.completions.add(work);
      live.completion = work;
    } finally { if (reserved) this.launching--; this.resuming.delete(id); }
    this.changed();
    return `${id} had finished, so I resumed it with its earlier conversation. Its new report will come back on its own.`;
  }
  /**
   * Resumes the main agent's subagents that the last Pi close or crash cut off, then tells the main agent once.
   * Cut-off children of a cut-off parent wait for it: resuming it names them, and its `tell` resumes them.
   */
  async resumeCutOff() {
    const cut = [...this.history.records.values()].filter(run => run.cutOff).sort((a, b) => a.depth - b.depth || a.started - b.started).map(run => run.id);
    const resumed: string[] = [], lines: string[] = [], orphans: string[] = [];
    // Always the current record: a `tell` during startup may have resumed the run and replaced it meanwhile.
    const current = (id: string) => { const run = this.history.records.get(id); return run?.cutOff ? run : undefined; };
    const drop = (run: RunInfo) => { delete run.cutOff; this.save(run); };
    for (const id of cut) {
      const run = current(id);
      if (!run) continue;
      if (run.parentId) {
        // Its parent was not cut off (it was paused, say) or could not be resumed: nobody else will mention it.
        if (!this.history.records.get(run.parentId)?.cutOff && !this.running.has(run.parentId)) { orphans.push(`${run.id} (under ${run.parentId})`); drop(run); }
        continue;
      }
      try { await this.track(this.resume(id, RESTARTED, undefined)); resumed.push(id); }
      catch (error) {
        const still = current(id);
        if (!still) continue; // Resumed by someone else meanwhile.
        lines.push(`Could not resume ${id}: ${error instanceof Error ? error.message : String(error)}`); drop(still);
      }
    }
    if (orphans.length) lines.push(`Also cut off, but not resumed because their parent agent is not running: ${orphans.join(', ')}.`);
    if (!resumed.length && !lines.length) return;
    await this.report([`Pi restarted while subagents were working.${resumed.length ? ` Resumed ${resumed.join(', ')} from where ${resumed.length > 1 ? 'they' : 'it'} left off; ${this.settings.groupReports
      ? 'grouped reports do not survive a restart, so each one reports on its own.' : 'reports arrive as usual.'}` : ''}`, ...lines].join('\n'));
  }
  async finish(id: string, reason: FinishReason) {
    const live = this.running.get(id);
    if (live?.info.connected) {
      live.info.handoff ??= { reason }; this.save(live.info);
      await this.stop(id);
      await live.completion;
    }
    return this.history.records.get(id)?.handoff;
  }
  async recoverHandoffs() {
    const eligible = [...this.history.records.values()].filter(run => run.connected && !this.running.has(run.id) && !run.handoff?.delivered);
    const recovery = (async () => {
      for (const run of eligible) {
        run.handoff ??= { reason: 'owner-stopped' };
        transition(run, run.handoff.reason === 'complete' ? 'completed' : 'interrupted'); this.save(run);
        await this.deliverHandoff(run);
      }
    })();
    this.completions.add(recovery);
    try { await recovery; } finally { this.completions.delete(recovery); this.changed(); }
  }
  /** `live`: the run's still open session; without it, the window's session is reopened from its file. */
  private async deliverHandoff(run: RunInfo, live?: AgentSession) {
    const handoff = run.handoff;
    if (!handoff || handoff.delivered) return;
    if (!handoff.text) {
      const deferred = this.deferring.signal;
      if (deferred.aborted) return;
      // Written by the window itself, else by the compactor from every transcript (read after the window's try, which may have
      // checked things), else a labelled stub.
      let summary: string | undefined;
      try { summary = await this.writtenByWindow(run, live, deferred); }
      catch (error) {
        if (deferred.aborted) return;
        this.warn(`${run.id} could not write its own handoff, so the compactor writes it: ${error instanceof Error ? error.message : String(error)}`);
      }
      const records = [run, ...this.history.descendants(run.id)];
      let evidence: HandoffEvidence[] = records.map(record => ({ run: record, messages: [] }));
      if (summary === undefined) {
        evidence = records.map((record): HandoffEvidence => {
          try { return { run: record, messages: this.retained(record.id) }; }
          catch (error) { return { run: record, messages: [], transcriptError: String(error) }; }
        });
        try {
          if (!this.options.summarizeHandoff) throw new Error('No handoff summarizer configured');
          summary = await this.options.summarizeHandoff(run, evidence[0].messages, evidence.slice(1), deferred);
        } catch (error) {
          if (deferred.aborted) return;
          summary = `Automatic summary unavailable: ${String(error)}\nInitial request: ${run.task}\nLast recorded result: ${run.report ?? 'No final answer recorded.'}\nUndelivered guidance: ${undelivered(run).join('\n')}\nRead the saved transcript or run metadata for the full work and user corrections.`;
        }
      }
      const source = evidence.map(({ run: record, transcriptError }) => {
        const location = record.sessionFile && existsSync(record.sessionFile) ? `Full transcript: ${record.sessionFile}`
          : `No transcript available. Run metadata: ${join(this.profileDirectory, 'runs', `${record.id}.optchat.json`)}`;
        return `[${record.id}] ${record.state}${record.parentId ? ` · parent ${record.parentId}` : ''}\n${location}${transcriptError ? `\nTranscript read failed: ${transcriptError}` : ''}`;
      }).join('\n');
      handoff.text = `[${run.id}] Connected conversation ${handoff.reason === 'complete' ? 'completed by user' : `interrupted (${handoff.reason})`}. This describes the conversation ending, not proof that every task succeeded.\n${summary}\n${source}\n\n${fullChat(run.id)}`;
      run.report = handoff.text; this.save(run);
    }
    await this.report(handoff.text, { once: true });
    handoff.delivered = true; this.save(run);
  }
  /** The window's own session writes the handoff: Pi sends it one more message, so the request repeats the window's last one and
   * the provider reads it from its cache. After a restart the session is reopened from its file; a close while it reopens doesn't
   * wait for it, and it is disposed once open. */
  private async writtenByWindow(run: RunInfo, live: AgentSession | undefined, signal: AbortSignal) {
    const sessionManager = live?.sessionManager ?? savedSession(run);
    if (!sessionManager) throw new Error('its transcript is missing or unreadable');
    if (!sessionManager.buildSessionProjection().messages.some(message => message.role === 'assistant')) throw new Error('it never answered');
    if (live) return await this.askForHandoff(live, run, signal);
    const model = this.find(run.model);
    if (!model) throw new Error(`its model ${run.model} is not available`);
    // No thinking level: the session restores the one it ran with.
    const opening = this.open({ id: run.id, directory: run.cwd, depth: run.depth, parentId: run.parentId, connected: true, model, sessionManager });
    await abortable(opening, signal);
    if (signal.aborted) {
      void opening.then(async session => { await this.shutdown(session); this.dispose(session); }, () => {});
      throw new Error('Pi is closing');
    }
    const session = await opening;
    try { return await this.askForHandoff(session, run, signal); }
    finally { await this.shutdown(session); this.dispose(session); }
  }
  private async askForHandoff(session: AgentSession, run: RunInfo, signal: AbortSignal) {
    // Its children that this ending stopped never reported to it, so it is told they were stopped.
    const stopped = this.history.descendants(run.id).filter(child => child.parentId === run.id && child.state !== 'completed' && child.state !== 'failed').map(child => child.id);
    const limit = AbortSignal.any([AbortSignal.timeout(this.options.windowHandoffTimeout ?? 300_000), signal]);
    limit.throwIfAborted();
    // It may check facts with tools first, as in any turn. The handoff is its final reply: text next to an earlier tool call never counts.
    let reply: AgentMessage | undefined;
    const off = session.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') reply = event.message; });
    const abort = () => { void session.abort(); };
    limit.addEventListener('abort', abort, { once: true });
    // A tool that ignores the abort must not hold up closing or the fallback: the wait ends with `limit`, and the caller disposes the session.
    const prompting = session.prompt(windowHandoff(run.handoff?.reason ?? 'failed', { undelivered: undelivered(run), unread: run.handoff?.unread ?? [], stopped }));
    prompting.catch(() => {});
    try { await abortable(prompting, limit); limit.throwIfAborted(); await prompting; }
    finally {
      limit.removeEventListener('abort', abort); off();
      this.options.usage?.backfill(session.sessionManager.getEntries(), run.parentSession, 'subagent', run.id);
    }
    if (reply?.role !== 'assistant') throw new Error('it did not answer');
    return withUndelivered(run, handoffText(reply));
  }
  /** Ends a run and its descendants; `cause` is said in its report (the user's Ctrl+X by default). */
  async stop(id: string, cause: StopCause = 'user') {
    const live = this.running.get(id);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const descendants: LiveRun[] = [];
    const collect = (run: LiveRun) => { descendants.push(run); for (const child of this.directChildren(run.info.id)) collect(child); };
    collect(live);
    const stopping = descendants.filter(run => transition(run.info, 'stopping'));
    for (const run of stopping) {
      if (run.info.connected) run.info.handoff ??= { reason: 'owner-stopped' };
      else run.stoppedBy ??= run === live ? cause : 'parent';
      run.wake?.();
      try { this.save(run.info); } catch (error) { this.warn(`Could not save stop status: ${String(error)}`); }
    }
    await Promise.allSettled(stopping.map(run => run.session.abort()));
  }
  /** The user's delete: stops the run and its descendants if they still work, lets their reports reach their parents, then deletes their files. */
  async remove(id: string) {
    if (!this.history.records.has(id)) throw new Error(`No subagent ${id}.`);
    if (this.deleting.has(id)) throw new Error(`${id} is already being deleted.`);
    // A run that is live while being deleted reports its own deletion, even one a tell was resuming; a finished one has nothing left to say, so memory is told here.
    let reports = false;
    const runs = () => [id, ...this.history.descendants(id).map(run => run.id)], marked = new Set<string>();
    // An overlapping delete of a descendant keeps its own marks, so neither delete clears the other's.
    const mark = () => { for (const run of runs()) if (!this.deleting.has(run)) { marked.add(run); this.deleting.add(run); } };
    mark(); this.changed();
    try {
      // Launches and resumes register their runs before they settle, and a stopped parent can still have children launching.
      for (;;) {
        await Promise.allSettled(this.launches);
        const live = runs().flatMap(run => this.running.get(run) ?? []);
        if (!live.length) break;
        if (live.some(run => run.info.id === id)) reports = true;
        mark();
        await Promise.allSettled(live.map(run => this.stop(run.info.id)));
        await Promise.allSettled(live.map(run => run.completion));
      }
      mark();
      const records = runs().flatMap(run => this.history.records.get(run) ?? []);
      if (records.some(run => run.connected && !run.handoff?.delivered)) throw new Error(`${id} has a connected conversation whose handoff has not reached the main agent yet, so it was kept.`);
      for (const run of records.reverse()) this.history.remove(run.id); // Children first, so a failure never leaves one without its parent.
      if (!reports) this.memory.append('work', `[${id}] deleted by the user`);
    } finally { for (const run of marked) this.deleting.delete(run); this.changed(); }
  }
  /** Pi is closing: a handoff not written yet is left undelivered for the next start's recoverHandoffs(), and one being
   * written is aborted, so closing or /reload never waits on a model call. */
  deferHandoffs() { this.deferring.abort(); }
  async close() {
    this.closing = true; this.deferHandoffs();
    // Only work in progress is picked up at the next start: not paused runs waiting for the user, runs being stopped, or connected windows (they hand off).
    for (const { info } of this.running.values()) if (!info.connected && (info.state === 'running' || info.state === 'waiting')) info.cutOff = true;
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id, 'pi')));
    await Promise.allSettled(this.launches);
    await Promise.allSettled(this.completions);
  }
}
