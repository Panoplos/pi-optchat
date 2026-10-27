import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelChoice } from './compactor.ts';
import { record } from './cache.ts';
import { atomicWrite, type Store } from './store.ts';
import { DEFAULT_SETTINGS, readSettings, type Settings } from './settings.ts';

export const isWindows = process.platform === 'win32';
const PIPE_PREFIX = '\\\\.\\pipe\\';

export const dataHome = () => resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
/** `main` is the last model and thinking level picked in Pi while this profile was open, recorded on the first open too.
 * A role without its own pick follows `main`, so OptChat runs on the model the user is already using. */
export interface ProfileConfig extends Settings { compactor?: ModelChoice; subagent?: ModelChoice; main?: ModelChoice }
/** Roles whose own pick overrides following Pi's model. */
export type Role = 'compactor' | 'subagent';
/** What a role runs on: its own pick, else the model saved from Pi (`main`), else the model Pi is on now, which a profile that has not saved one yet passes in. */
export const roleChoice = (config: ProfileConfig, role: Role, pi?: ModelChoice) => config[role] ?? config.main ?? pi;
/** Victor's models, sent only when the user pins them; the defaults follow Pi instead. */
export const defaults: ProfileConfig = { ...DEFAULT_SETTINGS };
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function profilePath(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(dataHome(), 'profiles', name);
}
export function listProfiles() {
  const root = join(dataHome(), 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name)).map(f => f.name).sort() : [];
}
export function createProfile(name: string) {
  const dir = profilePath(name);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  mkdirSync(resolve(dir, '..'), { recursive: true, mode: 0o700 });
  // Claim the directory exclusively, so a competing creator cannot have its
  // profile overwritten or removed by this attempt's cleanup.
  mkdirSync(dir, { mode: 0o700 });
  try {
    saveConfig(dir, defaults);
    atomicWrite(join(dir, 'AGENTS.md'), `# ${name}\n\nThis is the ${name} profile.\nAdd your personal instructions here.\n`);
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
    catch { throw new Error(`Failed to create profile ${name}, and could not remove its incomplete directory: ${dir}`, { cause: error }); }
    throw error;
  }
}
export function saveConfig(dir: string, config: ProfileConfig) { atomicWrite(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && THINKING.some(level => level === value.thinking);
}
/** An absent choice is valid: that role follows the main model. */
const optionalChoice = (value: unknown) => value === undefined || modelChoice(value);
export function loadConfig(dir: string): ProfileConfig {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(value) || !optionalChoice(value.compactor) || !optionalChoice(value.subagent) || !optionalChoice(value.main)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  const { compactor, subagent, main } = value;
  try { return { ...compactor && { compactor }, ...subagent && { subagent }, ...main && { main }, ...readSettings(value) }; }
  catch (error) { throw new Error(`Invalid profile config: ${dir}/config.json: ${error instanceof Error ? error.message : String(error)}`); }
}
export function instructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
export function lastProfile() {
  try { const name = readFileSync(join(dataHome(), 'last-profile'), 'utf8').trim(); return listProfiles().includes(name) ? name : undefined; }
  catch { return undefined; }
}
export function rememberProfile(name: string) { atomicWrite(join(dataHome(), 'last-profile'), name); }

export class ProfileBusyError extends Error {
  constructor(readonly owner: string) { super(`Profile already running: ${owner}`); }
}
/** POSIX keeps a socket file in the profile itself, so every Pi on the profile finds the same one whatever its TMPDIR, and Git skips it. Windows has no Unix sockets, so the profile path is hashed into a named pipe in the machine-wide pipe namespace. */
export function profileSocket(dir: string, purpose: 'lock' | 'windows' = 'lock') {
  if (!isWindows) return join(dir, `${purpose}.sock`);
  // Hash the directory's real identity, so another casing, a junction or a symlink to the same profile finds the same pipe.
  let identity = resolve(dir); try { identity = realpathSync.native(identity); } catch {}
  return `${PIPE_PREFIX}optchat-${createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 16)}-${purpose}`;
}

// sun_path is 104 bytes on macOS and 108 elsewhere, both including the NUL; a Windows named pipe path is capped at 259 characters, which for the ASCII names OptChat generates is also its byte length. Node 22 binds a truncated socket instead of failing, so the length is checked before listen.
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : isWindows ? 259 : 107;
export function checkSocketPath(path: string) {
  const length = Buffer.byteLength(path);
  if (length > SOCKET_PATH_LIMIT) throw new Error(`Cannot listen on the profile socket: its path is ${length} bytes, over this system's limit of ${SOCKET_PATH_LIMIT}. Set OPTCHAT_HOME to a shorter directory: ${path}`);
}

/** A socket that may be replaced; a file that only shares its name is refused, never deleted. A Windows pipe has no filesystem entry, so there is nothing to check or remove. */
function existingSocket(path: string): { stat: Stats; removable: true } | { removable: false } | undefined {
  if (isWindows) return { removable: false };
  let stat; try { stat = lstatSync(path); } catch { return undefined; }
  if (!stat.isSocket()) throw new Error(`${path} is not an OptChat socket. Move it out of the profile and try again.`);
  return { stat, removable: true };
}
/** Removes a dead socket left by a previous owner. */
export function removeStaleSocket(path: string) { if (existingSocket(path)?.removable) unlinkSync(path); }

/** Asks the current owner who holds the socket; nothing answering means the entry is stale. A Windows pipe that has disappeared reports ENOENT instead of ECONNREFUSED. */
function readOwner(path: string) {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = createConnection(path); let message = '';
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Profile lock did not respond; refusing to steal it.')); });
    socket.on('data', data => { message += data.toString(); });
    socket.on('end', () => resolve(message || 'another Pi instance'));
    socket.on('error', e => { if ('code' in e && (e.code === 'ECONNREFUSED' || isWindows && e.code === 'ENOENT')) resolve(undefined); else reject(e); });
  });
}

/** OS-owned socket lifetime, no timeout-based stealing of a busy profile. */
export async function lockProfile(dir: string, description: string) {
  const socketPath = profileSocket(dir); checkSocketPath(socketPath);
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end(description); });
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
  });
  try { await listen(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    const before = existingSocket(socketPath);
    if (!before) throw new Error('Profile lock changed; try again.');
    const owner = await readOwner(socketPath);
    if (owner !== undefined) throw new ProfileBusyError(owner);
    // Nothing answered, so the entry is stale. POSIX leaves a file behind that can be removed; a Windows pipe disappears with its owner, so rebinding is the whole cleanup.
    if (before.removable) {
      if (statSync(socketPath).ino !== before.stat.ino) throw new Error('Profile lock changed; try again.');
      unlinkSync(socketPath);
    }
    await listen();
  }
  const unlock = () => new Promise<void>(resolve => server.close(() => resolve()));
  if (!isWindows) { try { chmodSync(socketPath, 0o600); } catch (error) { await unlock(); throw error; } }
  return unlock;
}

/** How often a held lease is renewed; a store lets one lapse after about 30 seconds without renewal. */
export const HEARTBEAT_MS = 10_000;
/** Holds the profile until the returned function is called: through the store's lease if it has one, else the machine-local lock. */
export async function holdProfile(store: Pick<Store, 'lock'>, dir: string, profile: string, description: string, warn: (text: string) => void) {
  const { lock } = store;
  if (!lock) return lockProfile(dir, description);
  const owner = await lock.lease(profile, description);
  if (owner !== undefined) throw new ProfileBusyError(owner);
  const beat = setInterval(() => {
    lock.heartbeat().catch((error: unknown) => { warn(`Could not renew the profile lease: ${error instanceof Error ? error.message : String(error)}`); });
  }, HEARTBEAT_MS);
  beat.unref();
  return async () => { clearInterval(beat); await lock.release(); };
}
