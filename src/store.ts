import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isEntry, isSummary, type Entry, type Part, type Summary } from './core/memory.ts';
import { EXTENSIONS, type Mime, type Saved, type Store } from './core/store.ts';

const MIMES = new Map<string, Mime>((Object.keys(EXTENSIONS) as Mime[]).map(mime => [EXTENSIONS[mime], mime]));

/** The one place a profile's store is chosen. A `store` setting will plug in here; until then every profile keeps its memory in files. */
export const storeFor = (directory: string, warn: (s: string) => void = console.error): Store => new FileStore(directory, warn);

/** Pi's imports before #201 started each message's text with a "[Historical …]" line; its `[IMP <day>]` head says that now, so
 * loading drops it. Only the two shapes Pi wrote match, `<source> · <ISO time> · conversation <id> · <title>` and (from #64)
 * `<source> · <YYYY-MM-DD HH:MM>Z · <13 characters of the id> · <title>`, so a message that itself starts "[Historical" keeps it.
 * A Claude Code memory note's line names the memory, and its source isn't one word, so it stays. */
export const LEGACY_HEADER = /^\[Historical [a-z]+ · \d{4}-\d{2}-\d{2}(?:T[\d:.]+Z · conversation \S+| \d{2}:\d{2}Z · \S+) · [\s\S]*?\]\n/;

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function atomicWrite(file: string, text: string | Uint8Array) {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  // One read-write handle: Windows refuses fsync on a read-only one, and it cannot open a directory at all, so there the file flush is the whole guarantee.
  const fd = openSync(temporary, 'w+', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  if (process.platform === 'win32') return;
  const parent = openSync(resolve(file, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
const otherWriter = (file: string) => new Error(`Another process wrote ${file}. Close every other Pi on this profile and restart Pi; nothing was written.`);
/** With `size`, refuses to append unless the file still has that size. A last line left without its newline is ended first. A write
 * cut short is truncated away before the error is thrown. Returns the new size. */
export function appendJson(file: string, value: unknown, size?: number) {
  const fd = openSync(file, 'a+', 0o600);
  try {
    const length = fstatSync(fd).size, last = Buffer.alloc(1);
    if (size !== undefined && length !== size) throw otherWriter(file);
    const torn = length > 0 && readSync(fd, last, 0, 1, length - 1) === 1 && last[0] !== 0x0a;
    const data = Buffer.from((torn ? '\n' : '') + JSON.stringify(value) + '\n');
    // A cut-short write is undone, so the file keeps the size the caller checks against. Windows refuses to truncate through an
    // append handle, so this goes by path; if the undo fails too, the write's own error is still the one thrown.
    try { if (writeSync(fd, data) !== data.length) throw new Error(`Incomplete write: ${file}`); }
    catch (error) { try { truncateSync(file, length); } catch {} throw error; }
    fsyncSync(fd);
    return fstatSync(fd).size;
  } finally { closeSync(fd); }
}
function records(dir: string, warn: (s: string) => void): unknown[] {
  if (!existsSync(dir)) return [];
  const result: unknown[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
    const file = join(dir, name);
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try { result.push(JSON.parse(line)); }
      catch { warn(`Skipped damaged JSON at ${file}:${index + 1}`); }
    }
  }
  return result;
}

/** Memory as files in one directory: `main/` and `tree/` hold dated JSONL, each line fsynced as it is appended; `view.json` and
 * `images/<hash>.<ext>` are replaced atomically. Every write is done when it returns. */
export class FileStore implements Store {
  /** Each log file's size as this store last left it, so a write by another process is refused instead of interleaved. */
  private readonly lastSeenBytes = new Map<string, number>();
  /** Texts stay in RAM, as before lazy text: Pi has the room, and reads stay as fast. */
  private readonly texts: string[] = [];
  private readonly summaries = new Map<string, string>();
  constructor(readonly directory: string, private readonly warn: (s: string) => void = console.error) {}
  load(): Saved {
    for (const sub of ['main', 'tree']) mkdirSync(join(this.directory, sub), { recursive: true, mode: 0o700 });
    const main = join(this.directory, 'main'), entries = records(main, this.warn);
    for (const name of readdirSync(main).filter(n => n.endsWith('.jsonl'))) this.lastSeenBytes.set(join(main, name), statSync(join(main, name)).size);
    const view = join(this.directory, 'view.json');
    // An unreadable view is rebuilt, as a damaged one is.
    let saved: string | undefined;
    if (existsSync(view)) try { saved = readFileSync(view, 'utf8'); } catch { saved = ''; }
    const tree = records(join(this.directory, 'tree'), this.warn);
    // Memory checks the rest; a record without its text is as broken here as before.
    if (!entries.every(isEntry)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.');
    if (!tree.every(isSummary)) throw new Error('Invalid OptChat summary record.');
    for (const { i, text, origin } of entries) this.texts[i] = origin ? text.replace(LEGACY_HEADER, '') : text;
    for (const { l, i, text } of tree) this.summaries.set(`${l}:${i}`, text);
    return { entries, tree, view: saved };
  }
  text(i: number) { return this.texts[i]; }
  summary({ l, i }: Part) { return this.summaries.get(`${l}:${i}`)!; }
  append(entry: Entry): undefined {
    const file = join(this.directory, 'main', `${localDay()}.jsonl`);
    if (!this.lastSeenBytes.has(file)) this.checkLog(file);
    this.lastSeenBytes.set(file, appendJson(file, entry, this.lastSeenBytes.get(file) ?? 0));
    this.texts[entry.i] = entry.text;
  }
  private checkLog(next: string) {
    const main = dirname(next), names = readdirSync(main).filter(n => n.endsWith('.jsonl'));
    if (names.length !== this.lastSeenBytes.size || names.some(n => statSync(join(main, n)).size !== this.lastSeenBytes.get(join(main, n)))) throw otherWriter(next);
  }
  appendNode(node: Summary): undefined { appendJson(join(this.directory, 'tree', `${localDay()}.jsonl`), node); this.summaries.set(`${node.l}:${node.i}`, node.text); }
  saveView(view: string): undefined { atomicWrite(join(this.directory, 'view.json'), view); }
  putImage(name: string, mimeType: Mime, data: Uint8Array): undefined { atomicWrite(join(this.directory, 'images', `${name}.${EXTENSIONS[mimeType]}`), data); }
  image(name: string) {
    let file: string | undefined;
    try { file = readdirSync(join(this.directory, 'images')).find(f => f.startsWith(`${name}.`) && MIMES.has(f.slice(name.length + 1))); } catch { return undefined; }
    const mimeType = file && MIMES.get(file.slice(name.length + 1));
    return file && mimeType ? { mimeType, data: readFileSync(join(this.directory, 'images', file)) } : undefined;
  }
}
