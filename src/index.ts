import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { parseArgs, parseSessionEntries, parseSkillBlock, type ContextUsage, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type CustomEntry, type ExtensionUIContext, type FileEntry, type SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Memory } from './memory.ts';
import { atomicWrite, storeFor } from './store.ts';
import { createCompressor } from './compactor.ts';
import { applyConfig, createProfile, describeOwner, holdProfile, isWindows, lastProfile, listProfiles, loadConfig, memoryDirectory, profilePath, readInstructions, rememberProfile, roleChoice, saveInstructions, ProfileBusyError, type ConfigPatch, type ModelChoice, type ProfileConfig, type RoleName } from './profiles.ts';
import { allowSearch, CONTINUITY, IMPORT_GUIDANCE, SEARCH_DOC, TURN_REFRESHED, VIEW_DOC } from './core/prompts.ts';
import { MASTER, modelsHint } from './prompts.ts';
import { cachePayload, record } from './core/cache.ts';
import { saveImages } from './images.ts';
import { asUser, atWork, buildContext, logMessage, previousExchange, refreshFraction, reportReceipt, REPORT_RECEIPT, REPORT_TYPE, RUN_BOUNDARY, textContent, turnStepUsage, turnUsage, typedText } from './transcript.ts';
import { boundedMessage, refreshedRun, refreshBudget, refreshPoint } from './core/messages.ts';
import { registerReportRenderer, type ReportDetails } from './report-message.ts';
import { memoryTools } from './tools.ts';
import { result, searchTool } from './core/tools.ts';
import { Children, loadedBuiltins, modelsTool, refreshContextFiles, TASKS, type ReportOptions } from './agents.ts';
import { isActiveRun, type RunInfo } from './runs.ts';
import { exportBrowser } from './browser.ts';
import { Inbox } from './inbox.ts';
import { checkpoint } from './checkpoint.ts';
import { pendingImport, prepareImport, runImport, discardImport, type ImportJob, type ImportProgress } from './import/job.ts';
import { parseSelection, stageSelection } from './import/plan.ts';
import { chooseImport, showProgress } from './import/ui.ts';
import { noteLimits, noteRefusal } from './limits.ts';
import { UsageLedger } from './usage.ts';
import { agentLabel, oneLine, showInspector, type InspectorPage } from './inspector.ts';
import { showAgentView } from './agent-view.ts';
import { inspectorShortcut, mountNavigation } from './navigation.ts';
import { joinHeadless, serveWindows } from './window-bridge.ts';
import { listAttachableAgents, type ImportAction } from './window-client.ts';
import { openConnectedWindow, registerConnectedRenderer } from './connected-window.ts';
import { openRemoteWindow, ROLE_STATUS, type Role } from './rpc-window.ts';
import { createHandoffSummarizer } from './handoff.ts';
import { mainTitle, TabTitle } from './title.ts';
import { showModelPicker, showSettings } from './settings-page.ts';
import { showMenu } from './menu.ts';

const binding = 'optchat.profile';
/** The profile a session is bound to; the latest binding wins. */
function boundProfile(entries: readonly FileEntry[]) {
  const saved = entries.findLast((e): e is CustomEntry => e.type === 'custom' && e.customType === binding);
  return record(saved?.data) && typeof saved.data.name === 'string' ? saved.data.name : undefined;
}
const CONNECT_MODES = ['auto', 'join', 'off'] as const;
/** Print mode routes `process.stdout` to stderr so only the answer reaches stdout; the joined reply goes to fd 1 itself. */
async function printReply(text: string) {
  const bytes = Buffer.from(`${text}\n`);
  for (let at = 0; at < bytes.length;) {
    try { at += writeSync(1, bytes, at); }
    catch (error) { if (!record(error) || error.code !== 'EAGAIN') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
}
interface Active { name: string; session: string; dir: string; config: ProfileConfig; memory: Memory; inbox: Inbox; children: Children; usage: UsageLedger; unlock: () => Promise<void> }

/** OptChat's own version, read from the package.json beside src/ (in the checkout and the npm package alike); none if unreadable. */
export const version = ((): string | undefined => {
  try {
    const data: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return data && typeof data === 'object' && 'version' in data && typeof data.version === 'string' ? data.version : undefined;
  } catch { return undefined; }
})();
const brand = version ? `OptChat v${version}` : 'OptChat';

/** Pi's `setContextUsage`, which the pinned Pi types predate; a Pi without it shows its own context figure instead. */
const usageSlot = (ui: ExtensionUIContext) => ui as ExtensionUIContext & { setContextUsage?: (usage: ContextUsage | undefined) => void };

export default function optchat(pi: ExtensionAPI) {
  let active: Active | undefined;
  let remote: Awaited<ReturnType<typeof openConnectedWindow>> | undefined;
  /** `pi -p` on a profile another Pi owns: the prompt goes to a subagent in that Pi (--optchat-connect). */
  let joined: Awaited<ReturnType<typeof joinHeadless>> | undefined;
  /** An RPC session on a profile another Pi owns: a connected window whose agent runs here (--optchat-connect). */
  let rpcWindow: Awaited<ReturnType<typeof openRemoteWindow>> | undefined;
  let closeWindows: (() => Promise<void>) | undefined;
  let recovery: Promise<void> | undefined;
  let run: AgentMessage[] = [];
  let previous: AgentMessage[] = [];
  let logged = 0;
  /** After a mid-turn refresh (#146), the run is sent from here on, after its task; 0 sends it whole. */
  let keep = 0;
  let view: string | undefined;
  let prompt = '';
  let runStarted = false;
  /** The run was started by a custom message (`sendMessage` with `triggerTurn` while idle): its first message is that input, shown or hidden. */
  let wake = false;
  let fault: string | undefined;
  /** Reports not yet in memory. `count`: how many subagent reports the text joins. `batch`: held while the rest of that spawn runs, not sent yet.
   * `steered`: last sent into a running turn, where Esc or a dequeue can clear it from Pi's queue unseen. `quiet`: see ReportOptions. */
  let reports: { text: string; count?: number; quiet?: boolean; batch?: string; steered?: boolean }[] = [];
  type Report = (typeof reports)[number];
  let idle = () => true;
  const receipts = new Map<AgentMessage, string>();
  let checkpoints = Promise.resolve();
  let importing = false;
  let stopping = false;
  let importController: AbortController | undefined;
  let importTask: Promise<void> | undefined;
  /** Where an import's choices come from (the terminal pickers or an app) and how it is followed once it runs. `ended`: it is over,
   * or never started, with `failure` if it failed. */
  type ImportStart = {
    choose: (job: ImportJob | undefined, signal: AbortSignal) => Promise<'resume' | Awaited<ReturnType<typeof chooseImport>>>;
    follow: (job: ImportJob, run: (signal: AbortSignal, progress?: (value: ImportProgress) => void) => Promise<unknown>, signal: AbortSignal) => Promise<boolean>;
    ended?: (failure?: unknown) => void;
  };
  /** An app's start or resume (pi-optchat/files), waiting for `/optchat import app` to run it: only a command may start the new
   * session an import ends with. */
  let appImport: ImportStart | undefined;
  let importRun: Promise<unknown> | undefined;
  /** The app's import requests the profile socket waits on. An import's new session closes that socket, so their replies go first. */
  const replying = new Set<Promise<void>>();
  let unmountNavigation: (() => void) | undefined;
  let inspectorController: AbortController | undefined;
  const shortcut = inspectorShortcut();
  const title = new TabTitle();
  let working = false;
  let untitle: (() => void) | undefined;
  const showTitle = (ctx: ExtensionContext) => {
    const a = active;
    if (a) title.show(text => ctx.ui.setTitle(text), mainTitle(a.name, working, a.children.ids.length));
  };
  /** Journals written before batches held plain strings. */
  const isPendingReport = (s: unknown): s is string | { text: string; count?: number; quiet?: boolean } =>
    typeof s === 'string' || record(s) && typeof s.text === 'string' && (s.count === undefined || typeof s.count === 'number') && (s.quiet === undefined || typeof s.quiet === 'boolean');
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  pi.registerFlag('optchat-profile', { description: 'OptChat profile (required for noninteractive sessions without a saved binding)', type: 'string' });
  pi.registerFlag('optchat-connect', { description: 'pi -p or RPC on a profile open in another Pi: auto (join it if busy, default), join (only join), off (error if busy)', type: 'string', default: 'auto' });
  pi.registerFlag('optchat-agent', { description: 'Open an existing background agent by exact ID in this terminal (TUI only; requires a running profile owner)', type: 'string' });
  /** `pi -p` joins with its prompt, an RPC session as a window running its own agent. JSON output carries Pi's own events, which a joined reply would bypass. */
  const connectFor = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'print' && ctx.mode !== 'rpc') return 'off';
    const mode = pi.getFlag('optchat-connect') ?? 'auto';
    const known = CONNECT_MODES.find(m => m === mode);
    if (!known) { process.exitCode = 1; throw new Error(`--optchat-connect must be ${CONNECT_MODES.join(', ')}; got ${String(mode)}`); }
    return known;
  };
  /** Pi exits 0 after an extension error; a pipeline must see a failed join. */
  const joinProfile = async (name: string) => {
    try { return await joinHeadless(profilePath(name)); }
    catch (error) { process.exitCode = 1; throw error; }
  };
  // The main model follows the profile: each pick in Pi is saved to its config.json, and opening the profile picks it again.
  // `--model`/`--provider`/`--thinking` on Pi's command line win over the saved choice for as long as this Pi runs; `--models` only keeps a saved model inside its scope.
  const launch = parseArgs(process.argv.slice(2)), pinnedModel = launch.model !== undefined || launch.provider !== undefined;
  // `restored`: where the last restore left Pi. Pi fires thinking_level_select without awaiting it, so a handler may run after the restore; that state isn't a pick.
  let restoring = false, restored: ModelChoice | undefined;
  const sameChoice = (a: ModelChoice | undefined, b: ModelChoice) => a?.provider === b.provider && a.model === b.model && a.thinking === b.thinking;
  const mainChoice = ({ model }: ExtensionContext): ModelChoice | undefined => model && { provider: model.provider, model: model.id, thinking: pi.getThinkingLevel() };
  /** This turn's refresh threshold, in characters, for Pi's effective window: a per-model `maxContext` set in /context caps the
   * model spec, so the budget and the figure the footer shows move with the number you set there. Pi reports it before the token count. */
  const budgetFor = (ctx: ExtensionContext, a: Active) =>
    refreshBudget(ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow, refreshFraction(a.config.refreshAt));
  /** Before a turn has a tail, the footer shows the threshold the turn is held to instead of Pi's raw window. */
  const showBudget = (ctx: ExtensionContext) => {
    if (active) usageSlot(ctx.ui).setContextUsage?.(turnUsage([], 0, budgetFor(ctx, active)));
  };
  const rememberMain = (ctx: ExtensionContext) => {
    // Read Pi's state, not the event: a model switch reports its thinking level before the model, and a late handler sees where both ended up.
    const a = active, main = mainChoice(ctx);
    if (restoring || !a || !main || sameChoice(restored, main)) return;
    restored = undefined;
    if (sameChoice(a.config.main, main)) return;
    try { applyConfig(a.dir, a.config, { main }); }
    catch (error) { ctx.ui.notify(`Could not save the main model to ${a.name}: ${errorText(error)}`, 'error'); }
  };
  pi.on('model_select', (_event, ctx) => { rememberMain(ctx); showBudget(ctx); });
  pi.on('thinking_level_select', (_event, ctx) => rememberMain(ctx));
  const restoreMain = async (ctx: ExtensionContext, active: Active) => {
    const { name, config: { main } } = active;
    restored = undefined;
    if (!main) {
      // A profile written before the main model followed Pi has no pick to restore. Record where Pi is, so it stops following Pi from the next open on.
      if (!pinnedModel) rememberMain(ctx);
      return;
    }
    if (pinnedModel || launch.models && !ctx.scopedModels.some(({ model }) => model.provider === main.provider && model.id === main.model)) return;
    const model = ctx.modelRegistry.find(main.provider, main.model), thinking = launch.thinking ?? main.thinking;
    restoring = true;
    try {
      const current = ctx.model?.provider === main.provider && ctx.model.id === main.model;
      if (!model || !current && !await pi.setModel(model).catch(() => false)) {
        ctx.ui.notify(`${name}'s main model ${main.provider}/${main.model} is unavailable; keeping ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'Pi\'s default'}.`, 'warning');
        return;
      }
      pi.setThinkingLevel(thinking);
      restored = mainChoice(ctx);
    } finally { restoring = false; }
  };
  const required = () => { if (!active) throw new Error('Choose an OptChat profile first: /optchat profile'); return active; };
  /** The status line, and for RPC hosts what this Pi is to its profile (`optchat.role`). A window keeps both itself (rpc-window.ts). */
  const status = (ctx: ExtensionContext) => {
    if (rpcWindow) return;
    const a = active;
    if (ctx.mode === 'rpc') ctx.ui.setStatus(ROLE_STATUS, a ? JSON.stringify({ role: 'owner', profile: a.name } satisfies Role) : undefined);
    if (!a) { ctx.ui.setStatus('stats:optchat', 'choose profile'); ctx.ui.setStatus('optchat', undefined); return; }
    // A display only: a broken import journal is refused where it matters, never here.
    let note: string | undefined;
    try { note = importing ? 'importing' : pendingImport(a.dir) ? 'import paused: /optchat import' : undefined; }
    catch { note = 'import journal invalid'; }
    // The name sits in Pi's stats line; only a state that needs a word gets the status line.
    ctx.ui.setStatus('stats:optchat', a.name);
    ctx.ui.setStatus('optchat', note);
  };
  // `steered` describes this process's Pi queue, so it is not journaled.
  const saveReports = () => { if (active) atomicWrite(join(active.dir, 'pending-reports.json'), JSON.stringify(reports, (key, value: unknown) => key === 'steered' ? undefined : value)); };
  const flush = () => {
    if (!active) return;
    while (logged < run.length) {
      const message = run[logged];
      const receipt = receipts.get(message);
      logMessage(active.memory, message, receipt); logged++;
      if (receipt && !receipt.startsWith(REPORT_RECEIPT)) active.inbox.acknowledge(receipt);
      receipts.delete(message);
      if (message.role === 'user') {
        const text = textContent(message.content), index = reports.findIndex(r => !r.batch && r.text === text);
        if (index >= 0) { reports.splice(index, 1); saveReports(); }
      }
    }
  };
  // Shown as a dark background box, not as the user's own message.
  const sendReport = (report: Report) => {
    const message = ({ text, count }: Report) => ({ customType: REPORT_TYPE, content: text, display: true, details: { count } });
    if (report.quiet) { pi.sendMessage<ReportDetails>(message(report), { deliverAs: 'nextTurn' }); return; }
    // A running turn takes this report now, ahead of the quiet ones Pi holds for the next turn: they go in first (their held copy is dropped).
    for (const r of [...idle() ? [] : reports.filter(r => r.quiet && !r.steered && r !== report), report]) {
      r.steered = !idle();
      pi.sendMessage<ReportDetails>(message(r), { triggerTurn: true, deliverAs: 'steer' });
    }
  };
  const deliverReport = async (text: string, { once = false, count, quiet }: ReportOptions = {}) => {
    if (once && (active?.memory.root.some(e => e.receipt === reportReceipt(text)) || reports.some(r => r.text === text))) return;
    const report = { text, count, quiet };
    reports.push(report); saveReports();
    if (!stopping) sendReport(report);
  };
  const holdReports = (batch: string, texts: string[]) => {
    reports = [...reports.filter(r => r.batch !== batch), ...texts.length ? [{ text: texts.join('\n\n'), count: texts.length, batch }] : []];
    saveReports();
  };
  const stop = async () => {
    remote?.close(); remote = undefined; joined?.close(); joined = undefined;
    const window = rpcWindow; rpcWindow = undefined; await window?.close();
    inspectorController?.abort(); unmountNavigation?.(); unmountNavigation = undefined;
    stopping = true; importController?.abort(); await importTask?.catch(() => {});
    if (!active) return;
    const old = active;
    try {
      // Ending connected windows and recovery must not wait on handoff summaries: the next start writes and delivers them.
      old.children.deferHandoffs();
      await closeWindows?.(); closeWindows = undefined;
      await recovery;
      await old.children.close(); flush(); if (!pendingImport(old.dir)) old.inbox.recover(old.memory);
      // No checkpoint here: a host may kill Pi a second after asking it to stop (#220). The next turn's checkpoint commits what this wrote.
      await old.memory.close(); await checkpoints;
    } finally {
      await old.memory.close(); await old.unlock(); active = undefined;
      run = []; previous = []; logged = 0; keep = 0; view = undefined; runStarted = false; receipts.clear(); prompt = ''; idle = () => true;
      untitle?.(); untitle = undefined; title.clear(); working = false;
    }
  };
  const CONNECT = 'Start a connected subagent conversation here', BACK = 'Back';
  const chooseProfile = async (ctx: ExtensionContext): Promise<string | undefined> => {
    // Outside the TUI (print, json, RPC hosts) never pick or create a profile: a dialog would hang the host, and a guess could write into the wrong memory.
    if (ctx.mode !== 'tui') return undefined;
    const names = listProfiles(), last = lastProfile();
    if (last) names.sort((a, b) => Number(b === last) - Number(a === last));
    const selected = await ctx.ui.select('OptChat profile', [...names, '+ Create profile']);
    if (selected !== '+ Create profile') return selected;
    const name = (await ctx.ui.input('New profile name', 'work or personal'))?.trim();
    if (!name) return undefined;
    createProfile(name); return name;
  };
  // An unbound TUI session skips the picker when the choice is clear (#238): /new keeps the window's profile, then OPTCHAT_PROFILE, then a lone profile.
  const defaultProfile = (ctx: ExtensionContext, event: SessionStartEvent): string | undefined => {
    if (ctx.mode !== 'tui') return undefined;
    const names = listProfiles();
    // Pi reloads extensions on /new, so the window's profile is only in the previous session's file (written once it has a message).
    if (event.reason === 'new' && event.previousSessionFile) {
      try {
        const kept = boundProfile(parseSessionEntries(readFileSync(event.previousSessionFile, 'utf8')));
        if (kept && names.includes(kept)) return kept;
      } catch {}
    }
    const env = process.env.OPTCHAT_PROFILE?.trim();
    if (env) {
      if (names.includes(env)) return env;
      ctx.ui.notify(`OPTCHAT_PROFILE: no profile named ${env}.`, 'warning');
    }
    return names.length === 1 ? names[0] : undefined;
  };
  const openProfile = async (name: string, ctx: ExtensionContext) => {
    const dir = profilePath(name);
    if (!existsSync(dir)) throw new Error(`Profile ${name} does not exist. Use /optchat profile to create it.`);
    // Pi's RPC mode binds extensions twice after new_session/switch_session/fork/clone (setRebindSession, then rebindSession()),
    // so session_start can arrive again for the session this profile already serves. Taking the lock again would meet our own socket.
    // Only the same session is kept: another session without a session_shutdown still fails loudly below.
    if (active?.name === name && active.session === ctx.sessionManager.getSessionId()) { await restoreMain(ctx, active); status(ctx); return; }
    const unlock = await holdProfile(storeFor(dir), dir, name, describeOwner({ profile: name, pid: process.pid, host: hostname(), cwd: ctx.cwd }), warning => ctx.ui.notify(warning, 'warning'));
    let openingMemory: Memory | undefined;
    try {
      const config = loadConfig(dir);
      // A role without its own pick follows Pi's model; the profile saves every pick, so this tracks /model and /thinking.
      const modelFor = (role: RoleName): ModelChoice | undefined => roleChoice(config, role, mainChoice(ctx));
      const picked = (role: RoleName): ModelChoice => {
        const choice = modelFor(role);
        if (!choice) throw new Error(`No model yet: choose one in Pi (/model), or give ${role === 'compactor' ? 'the compactor' : 'subagents'} their own with /optchat ${role === 'compactor' ? 'model' : 'agents model'}.`);
        return choice;
      };
      const sessionId = ctx.sessionManager.getSessionId();
      const usage = new UsageLedger(dir);
      usage.backfill(ctx.sessionManager.getEntries(), sessionId);
      const pending = join(dir, 'pending-reports.json');
      const saved: unknown = existsSync(pending) ? JSON.parse(readFileSync(pending, 'utf8')) : [];
      if (!Array.isArray(saved) || !saved.every(isPendingReport)) throw new Error('Invalid pending report journal.');
      const memory = await Memory.open(memoryDirectory(dir), createCompressor(ctx.modelRegistry, () => picked('compactor'), { onUsage: message => {
        usage.compression(message, 'compactor', sessionId);
        status(ctx);
      }, limits: dir, accepted: () => config.summaryAcceptBytes }), { warn: warning => ctx.ui.notify(warning, 'error'), jobs: config.jobs });
      openingMemory = memory;
      const inbox = new Inbox(dir);
      const recovered = pendingImport(dir) ? 0 : inbox.recover(memory);
      if (recovered) ctx.ui.notify(`Recovered ${recovered} unanswered inputs into ${name}'s memory. Ask to continue them when ready.`, 'info');
      const children = new Children(memory, ctx.modelRegistry, () => picked('subagent'), () => `${readInstructions(dir)}\n\n${IMPORT_GUIDANCE}`,
        deliverReport, text => ctx.ui.notify(text, 'error'), dir, { parentSession: sessionId, usage, limits: dir, builtins: () => loadedBuiltins(pi), settings: () => config, hold: holdReports,
          summarizeHandoff: createHandoffSummarizer(ctx.modelRegistry, () => picked('compactor'), message => usage.compression(message, 'compactor', sessionId), undefined, dir) });
      const loggedReports = new Set(memory.root.map(e => e.receipt));
      // Reports a crash held back with their unfinished siblings are delivered now, as they are.
      reports = saved.map(s => typeof s === 'string' ? { text: s } : { text: s.text, count: s.count, quiet: s.quiet })
        .filter(r => !loggedReports.has(reportReceipt(r.text)));
      atomicWrite(pending, JSON.stringify(reports));
      rememberProfile(name);
      active = { name, session: sessionId, dir, config, memory, inbox, children, usage, unlock }; fault = undefined; idle = () => ctx.isIdle();
      await restoreMain(ctx, active);
      showBudget(ctx);
      if (ctx.mode === 'tui') unmountNavigation = mountNavigation(ctx, children, memory, shortcut, page => { void inspect(ctx, page); });
      // A one-shot run (`pi -p`, JSON) exits after its own prompt, which would end every conversation connected to it.
      if (ctx.mode !== 'print' && ctx.mode !== 'json') closeWindows = await serveWindows(dir, children, () => !stopping && !importing && !pendingImport(dir), deliverReport, patch => configure(ctx, patch), (action, text) => {
        const reply = importFromApp(ctx, action, text); replying.add(reply); return reply;
      });
      untitle = children.subscribe(() => showTitle(ctx)); showTitle(ctx);
      status(ctx);
      const compactor = modelFor('compactor');
      // An RPC host (the OptChat app) shows the profile itself; the banner would sit over its first prompt every start.
      if (ctx.mode !== 'rpc') ctx.ui.notify(`${brand} · ${name} · ${memory.root.length} messages\nCompactor: ${compactor ? `${compactor.provider}/${compactor.model} (${compactor.thinking})` : 'Pi\'s model (pick one in Pi)'}`, 'info');
      const queuedReports = [...reports];
      if (!pendingImport(dir)) {
        // Queued before handoff recovery can start a turn, so a saved window start goes in ahead of that window's handoff.
        for (const r of queuedReports) if (r.quiet) sendReport(r);
        const recover = (work: Promise<void>, what: string) => work.catch(error => ctx.ui.notify(`${what}: ${errorText(error)}`, 'error'));
        // Only an interactive Pi picks cut-off subagents up by itself: a one-shot headless run would stop them again as it exits,
        // and an RPC host (the OptChat app) asks its user first, then sends `resume-cut-off` (pi-optchat/files' resumeCutOff).
        recovery = Promise.all([recover(children.recoverHandoffs(), 'Handoff recovery'), ...ctx.mode === 'tui' ? [recover(children.resumeCutOff(), 'Resuming subagents')] : []]).then(() => {});
      }
      setImmediate(() => { if (active?.memory === memory && !pendingImport(dir)) for (const r of queuedReports) if (!r.quiet) sendReport(r); });
    } catch (error) {
      await closeWindows?.(); closeWindows = undefined;
      untitle?.(); untitle = undefined; title.clear();
      if (active && active.memory === openingMemory) {
        unmountNavigation?.(); unmountNavigation = undefined;
        await active.children.close(); active = undefined;
      }
      await openingMemory?.close();
      await unlock(); throw error;
    }
  };

  /** A busy profile, joined as `pi -p` (its prompt goes to the owner) or as an RPC window (its agent runs here). */
  const joinBusy = async (name: string, ctx: ExtensionContext, options: Parameters<typeof openRemoteWindow>[3] = {}) => {
    if (ctx.mode !== 'rpc') { joined = await joinProfile(name); return; }
    const old = rpcWindow; rpcWindow = undefined; await old?.close();
    rpcWindow = await openRemoteWindow(pi, ctx, name, options); fault = undefined;
  };
  /** Opens `name` here, or joins it where --optchat-connect says to; a busy profile it may not join throws ProfileBusyError. */
  const openOrJoin = async (name: string, ctx: ExtensionContext) => {
    const connect = connectFor(ctx);
    if (connect === 'join') return joinBusy(name, ctx, { requireOwner: true });
    try { await openProfile(name, ctx); }
    catch (error) {
      if (error instanceof ProfileBusyError && connect === 'auto') return joinBusy(name, ctx);
      throw error;
    }
  };
  pi.on('session_start', async (event, ctx) => {
    stopping = false;
    const entries = ctx.sessionManager.getEntries(), boundName = boundProfile(entries);
    // A session with conversation in it belongs to its profile. One that is only bound (a fresh `/optchat profile` session) may still pick another.
    const settled = boundName !== undefined && entries.some(e => e.type === 'message' || e.type === 'custom_message');
    const flag = pi.getFlag('optchat-profile');
    try {
      if (boundName && typeof flag === 'string' && flag !== boundName) throw new Error(`Session belongs to ${boundName}; cannot resume it as ${flag}.`);
      // RPC binds extensions twice after new_session and the like (see openProfile): the window already serves this session.
      if (rpcWindow?.session === ctx.sessionManager.getSessionId()) return;
      const agentId = pi.getFlag('optchat-agent');
      if (agentId !== undefined) {
        if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('--optchat-agent requires an exact agent ID');
        if (ctx.mode !== 'tui') { process.exitCode = 1; throw new Error('--optchat-agent requires interactive Pi (not print, JSON or RPC mode)'); }
        if (settled) throw new Error('This session already contains a main conversation. Open the agent in a fresh Pi session.');
        const name = boundName ?? (typeof flag === 'string' ? flag : undefined);
        if (!name) throw new Error('--optchat-agent needs a profile: pass --optchat-profile');
        remote = await openConnectedWindow(pi, ctx, name, text => title.show(t => ctx.ui.setTitle(t), text), agentId);
        fault = undefined;
        // Pi sets its own title after session_start; retain the attached window title too.
        for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
        return;
      }
      let name = boundName ?? (typeof flag === 'string' ? flag : defaultProfile(ctx, event) ?? await chooseProfile(ctx));
      if (connectFor(ctx) === 'join' && !name) { process.exitCode = 1; throw new Error('--optchat-connect join needs a profile: pass --optchat-profile'); }
      for (;;) {
        if (!name) { status(ctx); return; }
        try { await openOrJoin(name, ctx); break; }
        catch (error) {
          if (!(error instanceof ProfileBusyError) || ctx.mode !== 'tui') throw error;
          // A resumed conversation already belongs to this profile, so another profile needs a new session (/optchat profile).
          // Older owners have no listing protocol. Keep their existing Connect/Back menu rather than failing startup.
          const listed = settled ? undefined : await listAttachableAgents(profilePath(name)).catch(() => undefined);
          const agents = listed ?? [];
          const hint = listed?.length === 0 ? '\nNo background agents are running. Ask the main agent to start one.' : '';
          const labels = new Map(agents.map(agent => [`Open subagent ${agent.id} · ${agent.state} · ${agentLabel(agent).slice(0, 80)}`, agent.id]));
          const choice = await ctx.ui.select(`${name} is open in another window\n${error.owner}${hint}`,
            [CONNECT, ...labels.keys(), ...(settled ? [] : [BACK])]);
          const agentId = choice && labels.get(choice);
          if (agentId) {
            try {
              remote = await openConnectedWindow(pi, ctx, name, text => title.show(t => ctx.ui.setTitle(t), text), agentId, true);
              fault = undefined;
              // An attached terminal saves no profile binding: its Pi session never persists, so there is nothing to resume.
              for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
              return;
            } catch (error) {
              ctx.ui.notify(errorText(error), 'error');
              continue; // It may have finished while the menu was open: refresh, never spawn a replacement.
            }
          }
          if (choice === CONNECT) { remote = await openConnectedWindow(pi, ctx, name, text => title.show(t => ctx.ui.setTitle(t), text)); fault = undefined; break; }
          if (choice !== BACK) throw error;
          name = await chooseProfile(ctx);
        }
      }
      if (name !== boundName) pi.appendEntry(binding, { name });
    } catch (error) {
      if (active) await stop().catch(() => {});
      if (ctx.mode === 'rpc') status(ctx); // The host learns no profile is open; the TUI keeps its line next to the error.
      fault = errorText(error);
      // Pi reports a throwing handler on stderr (print) or as an extension_error event (RPC); notify there is a no-op or easy to miss.
      if (ctx.mode !== 'tui') throw error;
      ctx.ui.notify(fault, 'error');
    }
    // Pi sets its own title once every session_start handler has finished, so put ours back afterwards.
    for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
  });
  pi.on('session_info_changed', () => title.reapply()); // Pi retitles the tab on session renames, just before this.
  pi.on('session_shutdown', stop);
  // Pi shows nothing when a switch is cancelled, so say why and what lets it through.
  const blockSwitch = (command: string, ctx: ExtensionContext) => {
    const children = active?.children, runs = children?.active ? children.ids.flatMap(id => children.live(id)?.info ?? []) : [];
    const label = (run: RunInfo) => !isActiveRun(run) ? 'finishing' : run.connected ? 'connected window'
      : run.state === 'paused' ? 'interrupted, waiting for you' : run.state === 'stopping' ? 'stopping' : 'working';
    const own = runs.filter(run => !run.connected), it = own.length === 1 ? 'it' : 'them';
    const how = [
      ...own.length ? [own.some(run => run.state === 'paused') ? `Open ${it} in /optchat agents and message ${it} to resume, or press Ctrl+X twice to stop.`
        : `Wait for ${it} to finish, or open ${it} in /optchat agents and press Ctrl+X twice.`] : [],
      ...runs.length > own.length ? [own.length || runs.length > 1 ? 'A connected window\'s agent ends when its window runs /complete or closes.' : 'It ends when that window runs /complete or closes.'] : [],
    ];
    const why = remote && !remote.ended ? 'in a connected window. Run /complete to end this conversation, then open a new Pi window.'
      : importing ? 'while an import is open. Close the import dialog or pause the import (Escape), then try again.'
      : !children?.active ? undefined
      : !runs.length ? 'while agents are starting or finishing. Try again in a moment.'
      : `while ${runs.length === 1 ? '1 agent is' : `${runs.length} agents are`} active: ${runs.map(run => `${run.id} (${label(run)})`).join(', ')}. ${how.join(' ')}`;
    if (!why) return undefined;
    ctx.ui.notify(`${command} is blocked ${why}`, 'warning');
    return { cancel: true };
  };
  pi.on('session_before_switch', (event, ctx) => blockSwitch(event.reason === 'new' ? '/new' : '/resume', ctx));
  pi.on('session_before_fork', (event, ctx) => blockSwitch(event.position === 'at' ? '/clone' : '/fork', ctx));
  pi.on('input', async (event, ctx) => {
    if (joined) {
      try {
        if (event.images?.length) throw new Error('Joining a running profile accepts text only; provide a file path for the agent to read.');
        await printReply(await joined.ask(event.text, ctx.cwd));
      } catch (error) { process.stderr.write(`OptChat: ${errorText(error)}\n`); process.exitCode = 1; }
      return { action: 'handled' };
    }
    if (rpcWindow) {
      // A prompt after /complete starts the next connected conversation, as new_session would, without the one before in its context.
      if (rpcWindow.completed) {
        try { await joinBusy(rpcWindow.profile, ctx); }
        catch (error) { ctx.ui.notify(errorText(error), 'error'); return { action: 'handled' }; }
      }
      return { action: 'continue' };
    }
    if (remote) {
      try {
        if (event.images?.length) throw new Error('Connected windows currently accept text only; provide a file path for the agent to read.');
        await remote.submit(event.text);
      } catch (error) { ctx.ui.notify(errorText(error), 'error'); ctx.ui.setEditorText(event.text); }
      return { action: 'handled' };
    }
    if (!active) {
      // Without a profile or flag, a headless run is plain Pi. A requested profile that failed to open refuses instead of running without memory.
      if (ctx.mode !== 'tui' && !fault) return { action: 'continue' };
      ctx.ui.notify(fault ?? 'Select a profile with /optchat profile before chatting.', 'error'); return { action: 'handled' };
    }
    if (importing || pendingImport(active.dir)) { ctx.ui.notify('This profile has an import in progress. Use /optchat import to resume or discard it, or switch profiles.', 'info'); return { action: 'handled' }; }
    if (event.source !== 'extension') {
      try { active.inbox.record(event.text, event.streamingBehavior !== undefined); }
      catch (error) { ctx.ui.notify(`Could not save input: ${errorText(error)}`, 'error'); return { action: 'handled' }; }
    }
    return { action: 'continue' };
  });
  pi.on('agent_start', (_event, ctx) => { working = true; showTitle(ctx); });
  // Every run starts here, reports sent while Pi is idle too (Pi 1.2+).
  pi.on('before_agent_start', async (event, ctx) => {
    if (rpcWindow) { await rpcWindow.beforeRun(event); return; }
    if (!active) return; // Plain Pi run: leave Pi's own prompt untouched.
    const a = active;
    flush(); run = []; logged = 0; keep = 0; view = undefined; runStarted = true; wake = event.messageType === 'custom';
    previous = a.config.previousExchange ? previousExchange(ctx.sessionManager.getBranch(), a.config.previousExchangeKB * 1000) : [];
    pi.appendEntry(RUN_BOUNDARY, { state: 'start' });
    // Pi's own prompt sections (AGENTS.md files, skills, cwd) stay; the profile's instructions go last.
    syncSearch(a.config);
    event.systemPromptOptions.customPrompt = allowSearch(`${MASTER}\n\n${modelsHint(roleChoice(a.config, 'subagent'))}\n\n${VIEW_DOC}${a.config.previousExchange ? CONTINUITY : ''}${a.config.memorySearch ? SEARCH_DOC : ''}`, a.config.memorySearch);
    event.systemPromptOptions.sections.instructions = `${readInstructions(a.dir)}\n\n${IMPORT_GUIDANCE}`;
    refreshContextFiles(event.systemPromptOptions);
    prompt = event.systemPrompt;
  });
  const DUPLICATE_REPORT = '(duplicate report, already delivered)';
  pi.on('message_end', async (event, ctx) => {
    if (!active || !runStarted) return;
    const bounded = boundedMessage(event.message);
    // Pi puts the message that starts a run first, before any context it or other extensions inject.
    const message = asUser(bounded, wake); if (bounded.role !== 'system') wake = false;
    // Before the message is logged, so the image its text names is already there for zoom; zoom's own images are kept already.
    if (message.role === 'user' || message.role === 'toolResult' && message.toolName !== 'zoom') {
      try { await saveImages(active.memory.store, message.content); }
      catch (error) { ctx.ui.notify(`OptChat could not keep an image: ${errorText(error)}`, 'warning'); }
    }
    if (!active) return;
    let ahead = -1;
    if (message.role === 'user') {
      try {
        const text = textContent(message.content);
        if (bounded.role === 'custom' && bounded.customType === REPORT_TYPE) {
          // A report sent again after a lost steer can still arrive twice (Pi kept the old steer after an abort): drop the extra copy.
          // Copies are counted, so a later report that happens to repeat an earlier text still arrives.
          const receipt = reportReceipt(text), copies = run.slice(logged).filter(m => receipts.get(m) === receipt).length;
          if (reports.filter(r => !r.batch && r.text === text).length <= copies && (copies > 0 || active.memory.root.some(e => e.receipt === receipt)))
            return { message: { ...bounded, content: DUPLICATE_REPORT, display: false } };
          receipts.set(message, receipt);
          // Pi puts a quiet report it held (a window's start) after the report that starts the turn (its handoff): it goes first.
          const quiet = (text: string) => reports.some(r => r.quiet && r.text === text);
          const at = run.findLastIndex(m => m.role === 'user' && !quiet(textContent(m.content)));
          if (logged === 0 && quiet(text) && receipts.get(run[at])?.startsWith(REPORT_RECEIPT)) ahead = at;
        } else {
          // The inbox journaled the typed input: match without image references or Pi's image notes.
          const typed = typedText(message.content), skill = parseSkillBlock(typed.bare);
          let receipt = active.inbox.claim(typed.text) ?? active.inbox.claim(typed.bare)
            ?? (skill ? active.inbox.claimSkill(skill.name, skill.userMessage) : undefined);
          if (!receipt) { active.inbox.record(text); receipt = active.inbox.claim(text); }
          if (receipt) receipts.set(message, receipt);
        }
      } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    if (ahead >= 0) run.splice(ahead, 0, message); else run.push(message);
    if (view !== undefined) {
      try { flush(); } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    if (bounded !== event.message) return { message: bounded };
  });
  pi.on('context_with_system', async (event, ctx) => {
    if (rpcWindow) return { messages: rpcWindow.context(event.messages) };
    try {
      if (!active) { usageSlot(ctx.ui).setContextUsage?.(undefined); return; } // Plain Pi run: pass context through unmodified.
      const a = required();
      if (importing || pendingImport(a.dir)) throw new Error('Profile is unavailable while importing.');
      if (fault) throw new Error(fault);
      if (view === undefined) {
        // A misconfigured summarizer retries forever, so say why instead of spinning silently.
        let shown: string | undefined;
        const show = () => {
          const error = a.memory.lastError;
          const text = `Waiting for OptChat summaries…${error ? ` failing: ${oneLine(error)}${error.includes('/optchat') ? '' : ' (see /optchat model)'}` : ''}`;
          if (text !== shown) ctx.ui.setWorkingMessage(shown = text);
        };
        show();
        const unsubscribe = a.memory.onChange(show);
        try { await a.memory.settle(ctx.signal); } finally { unsubscribe(); ctx.ui.setWorkingMessage(); }
        view = a.memory.render(); // Capture old history before logging the new input.
        flush();
      }
      // Extensions that run after ours (Pi's built-in MCP adds <mcp_servers>) still change the prompt; send what Pi has now.
      // A prompt without our preamble keeps the last one we built.
      const current = ctx.getSystemPrompt();
      if (current.startsWith(MASTER.slice(0, 40))) prompt = current;
      // A turn past its budget moves its steps into the view, keeping the task and the last tool call whole (#146).
      const budget = budgetFor(ctx, a);
      const refresh = refreshPoint(run, keep, budget);
      if (refresh) {
        const { cut, size } = refresh, began = Date.now();
        ctx.ui.setWorkingMessage(`OptChat: moving this turn's ${Math.round(size / 4000)}k tokens into memory…`);
        // The footer shows the tail at its threshold with the step memory is on, so the push is visible while it runs.
        const step = () => {
          const usage = turnStepUsage(budget, a.memory.stage);
          if (usage) usageSlot(ctx.ui).setContextUsage?.(usage);
        };
        try {
          flush();
          const unsubscribe = a.memory.onChange(step);
          try { step(); await a.memory.settle(ctx.signal); } finally { unsubscribe(); }
        } finally { ctx.ui.setWorkingMessage(); }
        view = a.memory.render(); keep = cut;
        ctx.ui.notify(`OptChat moved ${Math.round(size / 4000)}k tokens of this turn into memory (${((Date.now() - began) / 1000).toFixed(1)}s).`, 'info');
      }
      // The footer's context figure is the tail against this profile's refresh threshold, the number the turn is actually held to.
      usageSlot(ctx.ui).setContextUsage?.(turnUsage(run, keep, budget));
      // Built on every call, unlike the view, so it is never out of date; it goes last, after everything cached.
      return { messages: buildContext(event.messages, refreshedRun(run, keep, TURN_REFRESHED, budget), view, prompt, previous, atWork(a.children.working)) };
    } catch (error) {
      // Pi catches extension errors. Explicitly abort so it cannot fall back to old context.
      ctx.abort();
      try { flush(); } catch (persistenceError) { fault = errorText(persistenceError); }
      ctx.ui.notify(errorText(error), 'error');
      return { messages: [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    }
  });
  pi.on('before_provider_request', (event, ctx) => ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload);
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
  pi.on('session_before_compact', (event, ctx) => {
    if (rpcWindow) return; // Its conversation isn't in memory: Pi's compaction keeps it in bounds.
    // Overflow recovery is not compaction: the provider refused the request, and Pi retries the turn once it compacts. Letting it
    // through keeps the turn alive when the declared window is wrong (a proxy capping lower); the retried request is rebuilt from
    // the view and its tail is bounded, so it fits.
    if (event.reason === 'overflow') return;
    ctx.ui.notify('OptChat manages history between turns. Pi compaction is disabled.', 'info');
    return { cancel: true };
  });
  const collectUsage = (ctx: ExtensionContext) => {
    try { active?.usage.backfill(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId()); }
    catch (error) { ctx.ui.notify(`Could not save usage: ${errorText(error)}`, 'error'); }
  };
  // How much of the subscription's limits is used, as each answer's headers say it: the main chat's here, its agents' and the
  // compactor's where they are made. Kept for an app to show; only the Pi that holds the profile writes it. So a chat in a
  // connected window that runs in its own Pi saves nothing, and the snapshot is as old as this Pi's latest answer.
  pi.on('after_provider_response', event => { if (active) noteLimits(active.dir, event.headers); });
  pi.on('turn_end', (event, ctx) => {
    collectUsage(ctx);
    if (active && event.message.role === 'assistant') noteRefusal(active.dir, event.message.errorMessage);
  });
  pi.on('agent_settled', async (_event, ctx) => {
    collectUsage(ctx);
    try { flush(); active?.inbox.dropReturned(); } catch (error) { fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    // A report steered into this run that never reached it (Esc or a dequeue cleared Pi's queue) is sent again, now as its own turn.
    if (active && !fault && !stopping) for (const r of reports) if (r.steered && !r.batch) sendReport(r);
    if (runStarted) pi.appendEntry(RUN_BOUNDARY, { state: 'end' });
    runStarted = false; status(ctx);
    working = false; showTitle(ctx);
    if (active) {
      const dir = active.dir;
      checkpoints = checkpoints.then(() => checkpoint(dir)).catch(error => ctx.ui.notify(`Local checkpoint failed: ${errorText(error)}`, 'error'));
      await checkpoints;
    }
  });
  registerConnectedRenderer(pi);
  registerReportRenderer(pi);
  const memory = () => rpcWindow?.memory() ?? required().memory;
  const [zoom, date] = memoryTools(memory, id => rpcWindow ? rpcWindow.transcript(id) : required().children.transcript(id));
  pi.registerTool(zoom); pi.registerTool(date);
  pi.registerTool({ ...searchTool(memory), defaultActive: false });
  // The tool and its prompt line change together, once per toggle, so the cached prefix is otherwise stable.
  const syncSearch = ({ memorySearch }: ProfileConfig) => {
    const tools = pi.getActiveTools();
    if (tools.includes('search') !== memorySearch) pi.setActiveTools(memorySearch ? [...tools, 'search'] : tools.filter(name => name !== 'search'));
  };
  pi.registerTool({ name: 'spawn', label: 'Spawn background agents',
    description: 'Start background subagents, returning IDs immediately. Use only when the user asks. Give each task the cwd of the project it works on, so the subagent starts there with that project\'s AGENTS.md. Leave a task\'s model unset for the profile\'s default; name one only when the user asks, with an id from models(). Each receives the current memory view and read-only zoom/date. Whether children may delegate further, and how many agents may run at once, is set per profile. Completion reports arrive automatically; never poll or sleep waiting for them.',
    parameters: Type.Object({ tasks: TASKS }),
    async execute(_id, args, signal, _update, ctx) {
      const text = await required().children.start(args.tasks, ctx.cwd, signal); status(ctx);
      return result(text);
    },
  });
  pi.registerTool(modelsTool(() => required().children));
  pi.registerTool({ name: 'tell', label: 'Tell background agent', description: 'Send a message to a subagent. A running one gets it at its next tool boundary. A finished one you started is resumed with its earlier conversation, and its new report arrives automatically.',
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, args) { return result(await required().children.tell(args.id, args.message)); },
  });

  /** The settings page's options: every model Pi is logged in to, with the thinking levels it takes, sorted so each provider's models sit together. */
  const settingsOptions = (ctx: ExtensionContext, a: Active) => ({ profile: a.name, config: a.config,
    models: ctx.modelRegistry.getAvailable().map(m => ({ name: `${m.provider}/${m.id}`, thinking: getSupportedThinkingLevels(m) })).sort((x, y) => x.name.localeCompare(y.name)),
    dir: a.dir });
  /** Another app's settings change, through the profile socket: what the settings page offers and does, without the page. */
  const configure = (ctx: ExtensionContext, patch: ConfigPatch) => {
    const a = required();
    for (const role of ['compactor', 'subagent'] as const) {
      const choice = patch[role];
      // The models the settings page lists, matched by provider and ID apart: a model ID may contain a slash.
      if (choice && !ctx.modelRegistry.getAvailable().some(m => m.provider === choice.provider && m.id === choice.model && getSupportedThinkingLevels(m).includes(choice.thinking)))
        throw new Error(`${role}: ${choice.provider}/${choice.model} with thinking ${choice.thinking} is not offered by this Pi; it lists the models it is logged in to.`);
    }
    applyConfig(a.dir, a.config, patch);
  };
  /** Another app's import, through the profile socket: what /optchat import does, with the app's choices instead of the pickers. */
  const importFromApp = async (ctx: ExtensionContext, action: ImportAction, text: string) => {
    const a = required();
    if (action === 'import-pause') {
      // Only a run: a terminal's import still in its dialogs is the terminal's to cancel. Replies once the run has saved where it paused.
      if (!importRun) throw new Error('No import is running in this profile.');
      importController?.abort(); await importRun.catch(() => {}); return;
    }
    if (importing || appImport) throw new Error('An import is already open in this profile.');
    if (action === 'import-discard') { discardImport(a.dir); status(ctx); return; }
    const selection = action === 'import-start' ? parseSelection(text) : undefined;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let answered = false;
    const answer = (error?: unknown) => { if (answered) return; answered = true; if (error === undefined) resolve(); else reject(error); };
    appImport = {
      choose: async (job, signal) => {
        if (!!selection === !!job) throw new Error(job ? 'Resume or discard the pending import first.' : 'No paused import to resume.');
        return selection ? stageSelection(a.memory, selection, signal) : 'resume';
      },
      // The app follows the run through the status it writes, so the request is answered once it runs.
      follow: (_job, run, signal) => { const running = run(signal); answer(); return running.then(() => true, (error: unknown) => { if (signal.aborted) return false; throw error; }); },
      ended: failure => answer(failure ?? new Error('The import did not start.')),
    };
    pi.sendUserMessage('/optchat import app', { expandPromptTemplates: true });
    return promise;
  };
  const pickModel = async (ctx: ExtensionContext, role: 'compactor' | 'subagent') => {
    const a = required();
    if (ctx.mode !== 'tui') throw new Error('Choosing a model requires interactive Pi or optchat-app.');
    const choice = await showModelPicker(ctx, role, settingsOptions(ctx, a));
    if (choice) ctx.ui.notify(`${role}: ${choice.provider}/${choice.model} (${choice.thinking}); applies to new calls.`, 'info');
  };
  const inspect = async (ctx: ExtensionContext, page: InspectorPage) => {
    if (inspectorController) return;
    const controller = new AbortController();
    try {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('The inspector requires interactive Pi.');
      if (importing) throw new Error('Close the import dialog before opening the inspector.');
      inspectorController = controller;
      const signal = inspectorController.signal;
      const action = await showInspector(ctx, { profile: a.name, session: ctx.sessionManager.getSessionId(), children: a.children, usage: a.usage, memory: a.memory, page, signal,
        refreshUsage: () => { collectUsage(ctx); try { a.children.collectUsage(); } catch (error) { ctx.ui.notify(`Could not save child usage: ${errorText(error)}`, 'error'); } },
      });
      if (signal.aborted) return;
      if (action === 'model') await pickModel(ctx, 'subagent');
      else if (action) await showAgentView(ctx, { id: action.open, children: a.children, signal });
    } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
    finally { if (inspectorController === controller) inspectorController = undefined; }
  };
  pi.registerShortcut(shortcut, { description: 'Inspect OptChat agents, usage and background activity', handler: ctx => inspect(ctx, 'agents') });
  /** /optchat import, from the terminal or an app: the guards, staging with the old memory closed, the run, then a new session. */
  const openImport = async (ctx: ExtensionCommandContext, start: ImportStart) => {
    const a = required();
    if (!ctx.isIdle() || a.children.active || reports.length) throw new Error('Finish active work and pending reports before importing.');
    importing = true; importController = new AbortController(); let closed = false;
    status(ctx);
    const signal = importController.signal;
    importTask = (async () => {
      let job = pendingImport(a.dir);
      const plan = await start.choose(job, signal);
      if (!plan) return;
      if (plan !== 'resume') {
        signal.throwIfAborted();
        flush(); a.inbox.recover(a.memory); await checkpoints; await a.memory.close(); closed = true;
        signal.throwIfAborted();
        job = prepareImport(a.dir, a.memory, plan.entries, plan.mode, plan.skipped);
      }
      if (!job) return;
      if (!closed) { await a.memory.close(); closed = true; }
      const summarizer = (): ModelChoice => {
        const choice = roleChoice(a.config, 'compactor', mainChoice(ctx));
        if (!choice) throw new Error('No model yet: choose one in Pi (/model) or with /optchat model.');
        return choice;
      };
      const compress = createCompressor(ctx.modelRegistry, summarizer, { onUsage: message => {
        a.usage.compression(message, 'import', ctx.sessionManager.getSessionId());
      }, limits: a.dir, accepted: () => a.config.summaryAcceptBytes });
      const completed = await start.follow(job, (signal, progress) => importRun = runImport(a.dir, compress, signal, a.config.jobs, progress), signal);
      ctx.ui.notify(completed ? `Imported ${job.added} messages into ${a.name}. Previous memory retained at ${job.previous === '.' ? a.dir : join(a.dir, job.previous)}.`
        : 'Import paused. Use /optchat import to resume. Other profiles remain available.', 'info');
    })();
    let failure: unknown;
    try { await importTask; } catch (error) { failure = error; }
    finally { importing = false; importTask = undefined; importRun = undefined; importController = undefined; ctx.ui.setWidget('optchat-import', undefined); }
    start.ended?.(failure);
    // The socket awaited each request before this does, so its reply is written before the new session closes the socket.
    await Promise.all([...replying].map(reply => reply.catch(() => {}))); replying.clear();
    if (closed && !stopping) await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: a.name }); } });
    else status(ctx);
    if (failure) throw failure;
  };
  const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (remote && !remote.ended || rpcWindow) { ctx.ui.notify('Manage this profile in its original window. Here use /tell-main or /complete.', 'info'); return; }
    if (importing) throw new Error('Close the import dialog before changing profile settings.');
    let action = args.trim();
    if (!action) {
      const a = active;
      action = await showMenu(ctx, brand, a && { profile: a.name, messages: a.memory.root.length, pending: a.memory.pending,
        compactor: roleChoice(a.config, 'compactor'), agents: roleChoice(a.config, 'subagent'), error: a.memory.lastError }) ?? '';
    }
    if (action === 'import') {
      const a = required();
      if (!ctx.hasUI) throw new Error('/optchat import requires interactive Pi.');
      return openImport(ctx, { follow: (job, run, signal) => showProgress(ctx, job, run, signal), choose: async (job, signal) => {
        if (!job) {
          const summarizer = roleChoice(a.config, 'compactor', mainChoice(ctx));
          return chooseImport(ctx, a.name, a.memory, summarizer ? `${summarizer.provider}/${summarizer.model} (${summarizer.thinking})` : 'Pi\'s model', signal);
        }
        const selected = await ctx.ui.select(`Paused ${job.mode} import · ${job.added} new messages`, ['Resume import', 'Discard staged import', 'Cancel'], { signal });
        if (selected === 'Discard staged import' && await ctx.ui.confirm('Discard import?', 'Original memory stays unchanged. Staged summaries will be removed.', { signal })) { signal.throwIfAborted(); discardImport(a.dir); }
        return selected === 'Resume import' ? 'resume' : undefined;
      } });
    }
    const named = /^profile\s+(\S+)$/.exec(action)?.[1];
    if (ctx.mode !== 'tui' && (named || action === 'profile')) {
      // RPC and SDK hosts (Pi Web) have no picker and may not support ctx.newSession(), so a still-empty session binds in place.
      const first = `Run /optchat profile ${named ?? '<name>'} as the first message of a new session, or start Pi with --optchat-profile <name>.`;
      if (!named || active || remote || joined || ctx.sessionManager.getEntries().some(e => e.type === 'message' || e.type === 'custom_message')) throw new Error(first);
      // As with a requested profile: one that fails to open blocks prompts instead of running without memory.
      try { await openOrJoin(named, ctx); }
      catch (error) { fault = errorText(error); throw error; }
      pi.appendEntry(binding, { name: named });
      return;
    }
    if (action === 'profile') {
      if (!ctx.isIdle() || active?.children.active) throw new Error('Finish or stop active work before switching profiles.');
      const selected = await chooseProfile(ctx);
      if (!selected || selected === active?.name) return;
      await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: selected }); } });
      return;
    }
    if (action === 'settings') {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('/optchat settings requires interactive Pi or optchat-app.');
      return showSettings(ctx, settingsOptions(ctx, a));
    }
    if (action === 'model') return pickModel(ctx, 'compactor');
    if (action === 'agents model') return pickModel(ctx, 'subagent');
    if (action === 'agents' || action === 'usage' || action === 'activity') return inspect(ctx, action);
    if (action === 'instructions') {
      const a = required();
      const edited = await ctx.ui.editor(`${a.name} · AGENTS.md`, readInstructions(a.dir));
      if (edited !== undefined) { saveInstructions(a.dir, edited); ctx.ui.notify('Saved. Applies to the next turn and newly spawned agents.', 'info'); }
      return;
    }
    if (action === 'browse') {
      const a = required(), file = exportBrowser(a.memory, a.name, a.dir);
      // explorer.exe exits 1 even when it opened the file, so only its launch failing counts there.
      if (ctx.hasUI) execFile(isWindows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [file], error => { if (error && (!isWindows || error.code === 'ENOENT')) ctx.ui.notify(`Open ${file}`, 'info'); });
      ctx.ui.notify(file, 'info'); return;
    }
    if (action) throw new Error('Use /optchat [profile|settings|model|agents|usage|activity|instructions|browse|import].');
  };
  /** A connected window, whether its agent runs in the owner (`remote`) or here (`rpcWindow`). */
  const window = (): { complete(ctx: ExtensionCommandContext): Promise<void>; tell(text: string): Promise<void> } | undefined => rpcWindow ?? remote;
  pi.registerCommand('complete', { description: 'End this connected conversation and hand off to the main agent', handler: async (_args, ctx) => {
    const open = window();
    if (!open) { ctx.ui.notify('/complete is for connected subagent windows.', 'info'); return; }
    try { await open.complete(ctx); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
  } });
  pi.registerCommand('tell-main', { description: 'Send a message to the main agent from this connected window', handler: async (args, ctx) => {
    const open = window();
    if (!open) { ctx.ui.notify('/tell-main is for connected subagent windows.', 'info'); return; }
    try { await open.tell(args); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
  } });
  pi.registerCommand('optchat', { description: 'OptChat profiles, settings, models, agents, instructions, memory browser, and imports',
    getArgumentCompletions: prefix => ['profile', 'settings', 'model', 'agents', 'agents model', 'usage', 'activity', 'instructions', 'browse', 'import'].filter(s => s.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      // `/optchat import app` is how an app's request (importFromApp) runs as a command; typed, it finds none waiting.
      const app = args.trim() === 'import app' ? appImport : undefined;
      if (app) appImport = undefined;
      try { await (app ? openImport(ctx, app) : command(args, ctx)); } catch (error) { app?.ended?.(error); ctx.ui.notify(errorText(error), 'error'); }
      finally { app?.ended?.(); } // Answered already, unless it never got as far as running (an early `return`).
    },
  });
}
