# Import in detail

The README has the steps. This page lists what each source brings in and how duplicates, pauses and failures are handled.

## Sources

| Source | Where it reads |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Claude Code memories | `~/.claude/projects/*/memory/` |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` |
| Pi / OMP | `~/.pi/agent/sessions`, `~/.omp/agent/sessions`, and each OMP profile's `~/.omp/profiles/<name>/agent/sessions` (both write the same session format) |
| ChatGPT export | A ZIP, folder, or `conversations.json`. A ZIP is read with `unzip` on macOS/Linux and the built-in `tar.exe` on Windows; nothing is extracted to disk. |

Scanning is local and makes no model calls.

## Selecting

For Claude Code, its memories, Codex, and Pi / OMP, pick projects (busiest first), optionally filter by start date, then take all conversations or pick some.

| Key | Action |
| --- | --- |
| **Tab** (and **Space** when the filter is empty) | Toggle |
| **Enter** | Continue |
| Typing | Filter |
| **Ctrl+A** / **Ctrl+D** | Select / clear matches |
| **Esc** | Cancel |

Nothing is classified as work or personal for you.

## Cost

The preview shows a rough token estimate. This is not a price quote: a big import costs about 3x that estimate in compactor input, because every message is summarized and then re-read in merges, each with the memory view as (mostly cached) context.

## What gets imported

User messages and final assistant replies, word for word, with their original dates, as in Victor's recipe. Each newly imported conversation gets one note ahead of its new messages, naming its source, title, project and days; a conversation with nothing new gets none, and a memory file is already a note. The model sees an imported message as `[IMP 2026-04-08] user: …`, rendered from its origin and date rather than stored in its text, so old requests are not treated as new instructions and the text keeps its whole 512-byte line.

Older imports stored a `[Historical …]` header line in each message's text. Loading a profile drops it, so zoom, search and new summaries see the `[IMP <day>]` form; summaries already built keep their wording. The next import of any kind writes those messages into the new memory without their header, a quiet one-off migration. A paused import started before upgrading won't resume (its staged messages still have the header): discard it and start it again.

Left out:

- Tool calls and results, intermediate commentary, reasoning, subagent transcripts, replayed context, and image/audio/file bytes. Imported conversations keep a text placeholder for images.
- The output Claude Code logs for slash and shell commands. The command itself stays as typed (`/name args` or `!command`).
- Claude Code's `[Request interrupted by user]` markers and the replies they cut off. A message typed to Claude Code while it was working counts as a user message.
- The context messages Codex injects, such as the AGENTS.md instructions and the environment context.
- The messages OMP injects (reminders, background job notices).
- For Pi / OMP, the skill's text and command output: `/skill:name args`, `!command` and `$code` stay as typed. `!!` and `$$` commands, kept from the model, stay out.
- Pi sessions that ran under OptChat: their messages are already in a profile's memory.

Also:

- Dropped text never becomes a conversation's title.
- ChatGPT alternate branches are labelled as alternatives, and so are Pi / OMP branches left by a rewind (`[alternate branch]`).
- A forked session adds only its new messages.

## Claude Code memories

The auto-memory topic files in `~/.claude/projects/*/memory/` (not `MEMORY.md`, which only indexes them), picked by project. Each file becomes one dated note in the memory tree, not part of the prompt. An edited file comes in again as a newer note.

## Duplicates

Re-importing skips messages already present, even if titles or paths changed. A resumed Claude Code session copies earlier messages into its own file; those copies are matched by message id and text, so they come in once, also against messages an earlier import stored. Changed source messages can appear as a separate historical version.

## Pausing

**Pause import** (or Escape) saves progress, and so does restarting Pi. `/optchat import` then offers **Resume** or **Discard staged import**. While an import is pending, chat in that profile is blocked; other profiles still work. Imports need the main agent and its subagents to be idle.

## Safety

- Imports build a new memory generation and switch to it only when the whole tree is ready. The previous generation stays on disk.
- Source files are never modified.
- Damaged or unsupported records are listed before you start, so you can cancel or continue without them.
- Conversations that disappear during the scan are skipped with a warning.

See OpenAI's guides on [exporting ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) and the [conversation file format](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts).
