# OptChat on Pi Durable

`pi-optchat/durable` runs OptChat's memory in a [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) agent, such as one in a Cloudflare Durable Object behind the Agents SDK's `PiHarness`. It is `SqliteStore`, a `Store` over SQLite (in a Durable Object, the object's), a Pi Durable extension that builds each request from OptChat's view, and `optchatImport` for importing old history. The Worker, its prompts and tools stay in the app. It needs `@earendil-works/pi-durable` 1.4.x (an optional peer dependency; tested on 1.4.0) and imports nothing from Pi's terminal app or Node; `test/core-boundary.test.ts` keeps it that way.

## Wiring it up

```ts
const db = new DurableObjectSqliteDatabase(ctx.storage);         // the one Pi Durable's storage uses too
const read = (sql, ...params) => ctx.storage.sql.exec(sql, ...params); // synchronous reads of memory's texts
const memory = await openMemory(new SqliteStore(db, read), createCompressor({ model, retryable })); // or new SqliteStore(db, read, { images })
const memoryExtension = optchat({ memory });
registry.install(memoryExtension.extension);
const harness = await Harness.open(storage, { models: withCacheMarks(models), registry, onWake, settings: { compaction: { enabled: false } } }, context);
memoryExtension.attach(harness, context);
```

With the Agents SDK's `PiHarness` this goes in its `harness` factory, which supplies `storage`, `context` and `onWake` and resumes the Harness when an alarm wakes the object. A host without it passes an `onWake` that arms an alarm, and calls `harness.resume()` on open and on each alarm, or a task owed from before an eviction never runs.

`examples/durable-object` is a Worker built this way, importing `pi-optchat/core` and `pi-optchat/durable` as an app would (linked with `file:../..`, so run `npm run build` in the repo first: the package's `./core` and `./durable` are the built `dist/`), with the counters and endpoints its `proof.mjs` uses: it runs the Worker under `wrangler dev` with real model calls and checks a multi-turn chat, restarts and the cache.

## Child conversations

`memoryExtension.snapshot(task, ctx)` builds a child conversation's first input to submit (not `init` entries): the view with `afterView`'s text, the previous exchange, the run so far (in a tool's `execute`, up to the call that made it), then `task`. It is one text block, `[{ type: 'text', text }]`, so cache marks reach it. Tool calls and results can't go into another conversation as they are, so the exchange and run are `kind: text` lines as memory logs them, images as `[image]` (one kept out of Pi's transcript by its ref).

It isn't stable across restarts, by design: take it once. With Pi Durable's subagent recipe (find the child by `ownerTaskId`, submit with a `requestId`, `replay: 'safe'`), a rerun finds the child and its input and doesn't snapshot again:

```ts
const Review: Extension = defineExtension({ name: 'review', tools: [defineTool({
  name: 'review', description: 'A second opinion before a risky step.', parameters: Type.Object({ task: Type.String() }), replay: 'safe',
  execute: async ({ task }, api, context) => {
    const requestId = `review:${api.taskId}`;
    const child = await api.commit(async tx => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing) return { id: existing.id, submitted: !!await tx.submissionByRequest(existing.id, requestId) };
      // A copy of this conversation's agent, `optchat` included; only this tool goes.
      const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
      await configure(tx, created.id, { extensions: { remove: [Review] } });
      return { id: created.id, submitted: false };
    }, context);
    // A known requestId returns its submission whatever the content, so a rerun sends none.
    const content = child.submitted ? [] : await memoryExtension.snapshot(task, context);
    const settled = await (await (await api.conversation(child.id, context))!.submit({ type: 'input', content, requestId }, context)).wait(context);
    const answer = settled.answer && await api.commit(tx => tx.entry(settled.answer), context);
    return { output: [{ type: 'text', text: textContent(answer?.model?.[0]?.content) }] };
  },
})] });
```

Keep `optchat` selected in the child, as its copy of the owner's agent does. It then gets the read-only `zoom` and `date` (and `search` when on) and the `CHILD` prompt. The hooks leave it alone: no view in its requests, no refresh, logging, reset or summaries. Compaction is declined only for the parent, so a child compacts only if the app leaves Pi's compaction on.

- **Plain children** (no snapshot) should drop `optchat`, or they get the child prompt with no view.
- **A clean import** going live during a child's run makes the ids in its view point at the new memory.
- **Size:** the view (up to 128K bytes), `afterView`'s text, the previous exchange (up to `previousExchangeBytes`), the run (usually under `refreshAt` of the parent's window, but not capped: a large last step passes it) and the task. Pick a child model whose window holds all of it; on Cloudflare the input is one transcript row, under the 2 MB row limit.

## How it works

- **Each request** (`beforeRequest`, in the configured conversation only) is the system prompt, OptChat's view, the previous exchange and Pi's current context. The view and previous exchange are fixed for one context, so the requests of a tool loop share a cached prefix. Pi's older transcript is never sent. `afterView(ctx)`, if set, adds the app's own context for the turn right after the view, before the previous exchange and outside the view's cached prefix: fixed for the context like the view, asked again when a refresh rebuilds the view and after a restart (it may be called more than once per context, so keep it cheap), never logged. If it throws, the request goes without it rather than without the view.
- **Long runs** (`refreshAt`, 0.3 by default, 0 is off): once a run's messages since the last refresh pass that share of the model's window, the run up to its last answer is logged, the view is rebuilt, and the run goes on with its task and last step, as in Pi (#146). An earlier run still in the context, or a steer before the cut, moves into memory with the cut steps. The log's cursor says where the run is cut, so a restart sends the same request.
- **When the conversation is idle** (no run, nothing in the inbox, checked again inside the commit), the extension resets Pi's context and creates a background task, in one commit. The task logs what the reset ended into memory and waits for its summaries. Pi Durable runs the task and, after an eviction, its alarm wakes the object to finish it.
- **The log's cursor** is the log itself: each message logged from a Pi entry carries the receipt `pi:<entry id>`, written with the message. On open, the newest entry in memory is read again and the records it already has are skipped, so an entry cut off between its records (an answer with tool calls makes several) is completed. A restart logs nothing twice and summarizes nothing again. Only Pi's user, assistant and tool result entries are logged, plus a reset's note (`Conversation.reset(text)`, a tool's `handoff`) as `[Handoff note] …`, once the context it starts has ended. One endless chat with no resets of your own is still the recommended setup.
- **A failed save** stops memory's log: requests keep the view it has, and after a restart logging resumes from the receipts and Pi's transcript. Cloudflare resets the object itself only when a commit fails after the code ran (the output gate, which drops Pi's writes too); a write that throws at once, like `SQLITE_FULL` at the storage limit, doesn't, so the restart waits for idle eviction, a deploy, or the host's `ctx.abort()`, which the example calls from `warn`. `SQLITE_FULL` stops Pi's writes as well; the errors only memory's writes could hit (a row over 2 MB, a message index saved twice) are ruled out by the store's parts and by one Memory per database.
- **Compaction:** turn Pi's off; the extension also declines any that starts. OptChat's summaries replace it.
- **Large tool results** are sent as their head and tail (`boundedMessage`), capped as Pi does.
- **Images:** each image in a user message or tool result is named in memory's text as Pi's OptChat names it, `[image <16 hex digits>]` (SHA-256 of its base64, by Web Crypto), and kept in the store before the message is logged, so `zoom(id, 1)` returns it and the previous exchange names it instead of sending it again. OptChat doesn't resize images: Pi Durable's Photon processor (`createCloudflarePhotonImages()`) runs in Workers, but the memory it decodes in never shrinks again. Shrink photos when they arrive instead (Cloudflare Images, say), so the store and the model get the small copy too. Each image is also sent once to the compactor for its message's own summary (about 1¢ each), so shrinking on arrival helps there too; one the provider rejects is summarized by name. `SqliteStore` keeps images in `optchat_images`; to keep large binary data out of the database (its row size limit and storage cost), give it `{ images }`, an `ImageStore` with `putImage` and `image`. The example keeps them in R2.
- **Images in Pi's transcript:** Pi Durable keeps each transcript entry, base64 images included, in one row. So each image goes to memory's store once, and Pi's row keeps only its ref as a text block, `[image <16 hex digits>]`. A model-issued tool's images go there by themselves (`afterTool`); a user's go when the app passes the input through `offloadImages` before submitting it: `root.submit({ type: 'input', content: await memoryExtension.offloadImages(content) }, ctx)`. Each request gets the images back (`beforeRequest`), each read from the store once per request; memory's text is the same either way. `putImage` must keep the image or throw: one it refuses stays inline. So do a nested call's images, an input the app didn't pass through `offloadImages`, and a tool result whose text could pass Pi Durable's default bound with the refs (50 KB or 2,000 lines): Pi bounds a result by keeping one of its text blocks, which would drop the refs. The hook can't see a tool's own `outputLimits`, so a tool with lower limits must stay inside them to keep its images. On Cloudflare, a message's inline images must stay well under 2 MB. A ref the store lacks or can't read is sent as its text. Hooks run in the order extensions are selected (install order by default): a host's own `afterTool` before OptChat's sees images and one after sees refs; a host's own `beforeRequest` before OptChat's sees refs and one after sees images. A host that reads Pi's transcript itself, such as a chat UI, sees the refs too: get an image with `memory.store.image(name)`.
- **Tools:** `zoom` and `date` (plus `search` with `search: true`), replay-safe.
- **Cache marks:** `withCacheMarks(models)` adds OptChat's marks to Anthropic requests that carry a view, so a view that grows at its end is read from the cache. A request with its own `onPayload` is left alone.
- **Summaries of a group chat:** a chat that isn't one user talking to OptChat, such as a housing board with several people, gives `createCompressor` its own `system` prompt and names each speaker in the text, like "[Kari] …".
- **Imports** (`optchatImport`): `start(entries, 'append' | 'rebuild')` plans the import and saves the plan in `optchat_plan`; append keeps the log, its summaries and its view (so the cached prefix holds), rebuild orders everything by date and summarizes it all again. A Pi Durable task builds the new memory beside the live one, as a new generation of the same tables, and carries on after an eviction; it saves its progress every 50 summaries, so restarts during a long import don't park it. The chat goes on with the old memory meanwhile. Once the new one is complete it goes live in one transaction and `onActivated` is called: restart the object there, since the memory in RAM is still the old one: `ctx.abort()` once `ctx.storage.sync()` resolves, as the example does. Aborting at once drops the responses still waiting on the writes, such as that of the `start()` call itself when the import had nothing to summarize; a request that is mid-reply at the switch fails either way, and Pi Durable runs its turn again after the restart. On open, chat messages the old memory logged from Pi's transcript during the import are logged again; messages a host appended to memory directly meanwhile are not, so don't. The old generation's rows are deleted then too. `pending()` gives the job and its task's state; `discard()` stops it. A second import, or one after a failed save, is refused. Neither the plan nor the log's texts are held in RAM. Two memories summarize at once during an import: open the import's with fewer jobs (`jobs: 4`) to stay under the model's rate limit.
- **Storage:** tables `optchat_log`, `optchat_tree`, `optchat_view` (each row with its generation), `optchat_state`, `optchat_plan` and `optchat_images` beside Pi's `pi_*`, in the same database and queue. A message is stored in parts of 512K UTF-16 units, under the 2 MB row limit; an image is one row. Memory keeps only metadata and node sizes in RAM (about 5 MB of heap for a 16,000-message log, measured in workerd) and reads texts through `read` as it needs them, synchronously, so zoom, search and views stay synchronous.
