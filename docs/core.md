# OptChat core

`pi-optchat/core` is OptChat's memory without Pi: the log, the summary tree and its views, zoom/date/search, the compactor, cache marks and memory's prompts. It is meant for hosts such as Pi Durable in a Cloudflare Durable Object. The Pi extension (`pi-optchat`) is built on it and behaves exactly as before.

Core imports nothing from Pi or Node at runtime: only `typebox` (the tools' schemas) and pi-ai's types. `test/core-boundary.test.ts` keeps it that way. Pi's packages are optional peer dependencies, so installing `pi-optchat` outside Pi pulls in none of them.

`pi-optchat/core` and `pi-optchat/durable` ship as compiled JavaScript with declarations, so a host needs no special tsconfig or bundler.

## What a host supplies

- **A `Store`:** `load`, `append`, `appendNode`, `saveView`, `putImage` and `image`, sync or async, plus `text` and `summary`, which must be synchronous. Memory loads only metadata when it opens, reads texts through `text`/`summary` as it needs them, and issues its writes in order. Pi's is `FileStore` (`src/store.ts`); Pi Durable's is `SqliteStore` (`pi-optchat/durable`, see [durable.md](durable.md)).
- **The compactor's model:** `createCompressor({ model, retryable })`, where `model()` returns `{ model, reasoning, stream }` for each call (pi-ai's `Models.streamSimple` or one with its shape) and `retryable` is pi-ai's `isRetryableAssistantError`.
- **Image names**, if it keeps images: `logMessage` and `textContent` take an `imageRef` that names an image by its ref, `[image <16 hex digits>]`: `ref(name)` builds one and `refName(text)` reads the name back from a text that is only a ref. `loadImage(store, name)` and `loadImages(store, text)` read the images back from the store.

## What it exposes

`src/core/index.ts` lists the exports by name: only these are public.

```ts
import { createCompressor, logMessage, memoryTools, openMemory, withView } from 'pi-optchat/core';

const memory = await openMemory(store, createCompressor({ model: () => ({ model, stream: models.streamSimple.bind(models) }), retryable }));
logMessage(memory, message);                       // each message of a turn, as the recipe's kinds
await memory.settle();                             // until the view's lines are built
const request = withView(run, memory.render());    // the view goes before the user's words
const [zoom, date] = memoryTools(() => memory);    // VIEW_DOC tells the model how to use them
```

- `openMemory(store, compress, { warn, budget, jobs, retryMs })`, and `Memory`: `append`, `text`, `render`, `settle(signal?, 'turn' | 'tree' | 'ahead')`, `zoom`, `search`, `date`, `onChange`, `close`, plus `root`, `tree`, `view`, `pending`, `lastError`, `saveError`.
- `Store`, `Saved`, `Lease`, `ImageStore` (a store's `putImage` and `image`, for keeping images elsewhere), `Mime`, `isMime`, and the record types `Entry`, `Summary`, `Origin`, `Kind`. An entry with an `origin` is imported history, which the summarizer treats as historical; `origin.source` is any label the host picks ("email").
- `createCompressor({ model, retryable, onUsage?, accepted?, retryDelays?, system? })` (`system`: the compactor's prompt, `COMPACT` by default), `ACCEPTED_BYTES`.
- `logMessage(memory, message, { kind?, receipt?, imageRef? })` (every entry it appends gets `receipt`, so a host can use it as a cursor), `textContent`, `withView`, `boundedMessage`, `completedExchange`, `childInput({ view, previous?, run?, task })` (a child conversation's first input, as Pi's subagents and durable `snapshot` build it), and the mid-turn refresh helpers (`refreshBudget`, `refreshPoint`, `refreshedRun`).
- `memoryTools(memory, runs?)` (zoom and date; `runs` adds zooming into a subagent's chat), `searchTool`, `ref`, `refName`, `loadImage`, `loadImages`, `isImage`, `decode`.
- `cachePayload` (Anthropic: the view's cache marks, as a request's `onPayload`).
- Imports: `planImport(existing, incoming, 'append' | 'rebuild', copyOf?)` dedupes by `receipt` (each starts with `import:`) and orders the new history by date: append keeps the existing log as the plan's first `kept` entries, rebuild orders everything and summarizes it again. `runImport({ entry, total, open, activate }, signal)` builds the memory `open` gives from the plan's `total` entries, read one at a time through `entry(i)` so the plan need not stay in RAM, resuming where it stopped, and calls `activate` once the whole tree is built and the memory is closed. The host keeps the plan, seeds the staging store (append: the kept entries, the summaries and the saved view), and switches to it in `activate`. Until then the live memory must take no messages, or the switch drops them: queue them and log them after. `deduplicate` alone tells what would be new, and `chronological` is the order rebuild uses. `pi-optchat/durable`'s `optchatImport` does all this on SQLite.
- Prompts: `COMPACT`, `VIEW_DOC`, `CHILD`, `CONTINUITY`, `SEARCH_DOC`, `allowSearch`, `TURN_REFRESHED`.

Not in core: the turn itself (when to snapshot the view, refresh mid-turn, replay the previous exchange). Each host does it with the helpers above: Pi in `src/index.ts`, Pi Durable in `src/durable/optchat.ts`.
