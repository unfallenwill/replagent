# Session storage

How a conversation survives the process that produced it, so that
`replagent --resume` can continue one, a human can read one, and the model
gets back exactly the context it had.

This is deliberately close to Claude Code's layout - a directory per project,
a JSONL file per session, append-only - because that model is proven, it is
greppable with the tools already on the machine, and it degrades well when a
process dies mid-write. The differences are the ones our agent needs: no
subagent sidechains, no tool transcript, and reasoning blocks that must
survive byte for byte because the provider accepts them back.

## 1. Where sessions live

```
~/.replagent/
└── projects/
    └── C--Users-hicaosen-GitHub-replagent/
        ├── 20261023T191005Z-844430e2.jsonl
        └── 20261022T203300Z-0ee2b09e.jsonl
```

- `REPLAGENT_HOME` overrides `~/.replagent`. Tests and CI point it at a
  temporary directory; a human can point it at a synced folder.
- The project directory name is the absolute working directory with `:` and
  path separators each replaced by `-` - the same scheme Claude Code uses
  (`C:\Users\hicaosen\GitHub\replagent` becomes
  `C--Users-hicaosen-GitHub-replagent`: the colon and the backslash each
  leave a dash). Runs of separators are not collapsed. Same-looking
  directories for the same project across the two tools are a feature, not a
  collision: the files live under different homes.
- The session id is the file name stem: `20261023T191005Z-844430e2`.
  Timestamp first so `ls` is chronological without reading anything;
  eight hex characters from `crypto.randomBytes(4)` so two sessions started
  in the same second cannot collide.

Sessions do **not** go in the repository. A session contains everything the
agent read and printed - source, logs, whatever a tool happened to dump -
and a project's git history must not collect that. There is no second file
beside the session: the agent has no beliefs of its own to keep, only the
queue it read and the words it said, and both are in the log.

## 2. The file

One JSON object per line, UTF-8, `\n`-terminated. The first line is the
header; every later line is an event. Files are opened `O_APPEND` and never
rewritten in place. Mode `0600`, directory `0700`.

### Header

```json
{
  "v": 2,
  "type": "session",
  "id": "20261023T191005Z-844430e2",
  "at": "2026-10-23T19:10:05.120Z",
  "cwd": "C:\\Users\\hicaosen\\GitHub\\replagent",
  "model": "MiniMax-M3.1-Flash",
  "effort": "max",
  "maxTokens": 131072,
  "maxSteps": 24,
  "systemPromptHash": "sha256:9f2c...",
  "agent": "replagent"
}
```

`v` is the schema version of the file, not of the app. A reader that meets a
version it does not know refuses to resume and offers read-only display;
a reader that meets older versions migrates. `systemPromptHash` makes it
possible to see later that a resumed session's cache prefix changed for a
reason other than the conversation. `agent` is the name of the writer, not
its version - the schema version is `v`'s job.

The header is the only place a session's model and effort live. A turn
cannot raise them, and a resume compares the header's model against the
`--model` it was given to decide whether the reasoning may be replayed.

A v1 file also carried `"world": ".replagent/world.json"`. A v2 file has no
world to name: the world model is gone, and the queue replaced it. The
reader still accepts a v1 header - it has to, because v1 files exist - and
still refuses a v1 header that does not name one, so a file that is not a
replagent session is not mistaken for one.

### Events

Every event carries `seq` (1, 2, 3... in this file) and `at`:

```json
{
  "seq": 2,
  "at": "2026-10-23T19:10:06.004Z",
  "type": "queue",
  "entries": [{ "origin": "human", "text": "add a cache to the loader" }]
}
```

`seq` is what a gap would be noticed by - the current reader does not refuse
a file over one. It is per-file and monotonic; it is not a global clock.

The event types:

| `type`       | payload                                                               | why it is stored                                         |
| ------------ | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `turn.start` | `{}`                                                                  | boundaries; interruption detection                       |
| `queue`      | `{ entries: [{ origin, text }] }`                                     | **what went into the request**                           |
| `message`    | `{ message: { role, text, thinking? }, origin, usage?, stopReason? }` | **the context itself**, in the order it was appended     |
| `step`       | `{ name, description }`                                               | the step named itself before it ran                      |
| `tool`       | `{ tool, intent, detail }`                                            | what the step did, and why it said it was doing it       |
| `say`        | `{ text }`                                                            | what the agent said to the human                         |
| `note`       | `{ text }`                                                            | limits, truncation, unwrapped tool calls                 |
| `turn.end`   | `{ status }`                                                          | `finished · cancelled · limit · rejected · error · idle` |
| `title`      | `{ text }`                                                            | a human's name for the session; last one wins            |

`origin` says whose message it is and how the replay should draw it:
`human` (echo it as the human's turn), `assistant` (the model's program and
reasoning), `observation` and `resume` (v1 only - what the model read back,
and the note a resume added). It is on the event, not on the `LlmMessage`,
because the message itself must stay exactly what went to the provider.

A `message` event carries the assistant call's metadata beside the message -
`usage` and `stopReason` - so the log answers "what did this cost" without a
second event type. The model and effort are the header's, not each turn's.

### The principle behind the split

Two kinds of truth are stored side by side:
- **`queue` and `message` events are normative.** They are exactly the values
  handed to `Conversation.append` - the labelled block the model read, and
  the assistant's program with its reasoning blocks and signatures. Replaying
  them through the same `append` reproduces the live `Conversation` exactly,
  including the merge of consecutive same-role turns.
- **The rest is for the human.** `step`, `tool`, `say` and `note` let a
  resumed session repaint the transcript's folds; `turn.*` and `usage`
  answer what happened and what it cost. None of them is needed to rebuild
  context, and losing them degrades the display, not the conversation.

A `queue` event stores the **entries**, not the text that was rendered from
them. The rendering is a pure function of the entries - `formatQueue` labels
every line - so the entries are the smaller and more faithful form: a resume
rebuilds the request exactly, labels included, and the log cannot disagree
with the model about what it was told.

### Sample

```jsonl
{"v":2,"type":"session","id":"20261023T191005Z-844430e2",...}
{"seq":1,"at":"...","type":"turn.start"}
{"seq":2,"at":"...","type":"queue","entries":[{"origin":"human","text":"add a cache to the loader"}]}
{"seq":3,"at":"...","type":"message","message":{"role":"assistant","text":"await step(...)","thinking":[{"text":"...","signature":"sig"}]},"origin":"assistant","usage":{"input":5120,"output":140,"cached":4800},"stopReason":"end_turn"}
{"seq":4,"at":"...","type":"step","name":"read the loader","description":"see how it fetches"}
{"seq":5,"at":"...","type":"tool","tool":"read src/loader.ts","intent":"see how it fetches","detail":"84 lines"}
{"seq":6,"at":"...","type":"say","text":"The loader has no cache yet."}
{"seq":7,"at":"...","type":"turn.end","status":"finished"}
```

A second round, where the agent deposited what it found and the human said
something else:

```jsonl
{"seq":8,"at":"...","type":"turn.start"}
{"seq":9,"at":"...","type":"queue","entries":[{"origin":"model","text":"The loader fetches on every call."}]}
{"seq":10,"at":"...","type":"queue","entries":[{"origin":"human","text":"now add the cache"}]}
```

Note what a deposit is not: it is not a `message`. The model's own words
never enter the conversation as an assistant turn - they enter as queue
entries, labelled `[you]`, and the model reads them back as a conclusion it
reached rather than as something it wrote. Only the program it wrote is an
assistant turn.

## 3. Writing

The writer is one append-only file handle for the whole session:

```ts
class JsonlSessionWriter implements SessionWriter {
  readonly id: string;
  readonly #fd: number;
  #seq: number;
  #closed = false;

  append(event: SessionEventInput): void {
    const line = `${JSON.stringify({ seq: this.#seq + 1, at: new Date().toISOString(), ...event })}\n`;
    writeAll(this.#fd, line); // loop on partial writes
    this.#seq += 1;
  }

  /** Make the turn durable. Called at turn.end, not per token. */
  checkpoint(): void {
    fsyncSync(this.#fd);
  }

  close(): void {
    closeSync(this.#fd);
    releaseLock(this.#file);
  }
}
```

The store creates the file with `flag: 'wx'` and mode `0600` and opens it for
appending at once; a session that is reopened continues from the last `seq`
in the file, so the sequence is per file, not per process.

Rules:
- **Turn granularity.** Events are written as they happen, but `fsync` runs
  when a turn ends. A process crash costs at most the OS's page cache flush,
  not a re-read of the conversation; an OS crash costs at most the current
  turn. Tokens are never written - `agent-code-delta` and friends are a
  rendering concern, and a log of deltas is a log nobody can resume from.
- **Log what was appended, not what was streamed.** Nothing enters the log
  until it enters `Conversation`. If a reply is cancelled mid-stream, it was
  never context, so it is never in the file.
- **One writer per session.** Creating or opening a file for writing creates
  `<id>.jsonl.lock` beside it with `{ pid, at }` using `flag: 'wx'`. If the
  lock exists and the pid is alive, resume is refused. If the pid is gone (a
  crash), the lock is removed and the session reopened. The lock is advisory;
  it protects against two terminals, not against a determined user.
- **Never rewrite.** Compaction, if it ever comes, appends a `snapshot`
  event (see §7); it does not rewrite history.

## 4. Reading and resuming

`open(idOrPrefix)` reads the file and splits it into lines:
1. Parse the header. A line that is not a header of a known `v` → fail the
   resume with "Not a replagent session"; the file is left untouched for
   read-only inspection.
2. The last line is dropped before parsing: a file that does not end in a
   newline ends in a write that was cut off. A torn tail is evidence, and a
   reader that rewrites on read is a reader that can destroy a session.
3. Every other line is `JSON.parse`d; a line that fails becomes a skip, not
   an exception. The count comes back as `ignoredLines` so a caller can say
   that the session was damaged without refusing to open it.
4. Unknown `type` values are ignored and counted the same way. Unknown fields
   are ignored. This is what lets a newer writer's file be opened by an older
   reader without losing the parts the reader understands.
5. One exception to 4: the v1 `observation` event type is **read and
   dropped**, and is not counted as damage. The transcript it belonged to is
   gone, but the line was written by a replagent, and a replagent file with
   one dropped line is not a damaged file.
6. Sequences are not checked for gaps. `seq` is there for a reader that wants
   to notice one; refusing to open a file because of it would trade a whole
   session for a diagnostic.

Rebuilding context is then:

```ts
export function restoreConversation(
  events: readonly SessionEvent[],
  replayThinking: boolean,
): Conversation {
  const conversation = new Conversation();
  for (const event of events) {
    if (event.type === 'message') {
      const thinking = replayThinking ? event.message.thinking : undefined;
      conversation.append(event.message.role, event.message.text, thinking);
      continue;
    }
    if (event.type === 'queue') {
      conversation.append('user', formatQueue(event.entries));
    }
  }
  return conversation;
}
```

The two kinds of event are read side by side, because the two kinds of file
are read the same way: a v2 file keeps what went into the request in its
queue events and the model's replies in message events, and a v1 file keeps
both as messages. A v1 file therefore replays with the queue branch never
taken, and a v2 file replays with the message branch carrying only the
assistant turns.

`replayThinking` is the caller's decision - `resumed.header.model === options.model`
in the CLI - because only the caller knows which model the next request is
for.

Two resume rules matter:
- **Model mismatch.** If the session was recorded against a different model
  (or the human passes `--model glm-4.6`), the reasoning blocks are kept in
  the log but not replayed; the turns become plain text. Signatures are the
  issuing provider's proof. Displaying the old thoughts is fine; sending
  them to a different endpoint is not.
- **An interrupted turn.** A `turn.start` with no matching `turn.end` means
  the process died mid-turn. The messages already appended stay in context -
  they were really sent, and the program may have really run - and resume
  appends a note saying so, then logs it like any other message:

  ```
  <queue>
  [error] The previous session ended while this turn was running. Its effects are unknown; check before repeating it.
  </queue>
  ```

  It wears the queue's clothes on purpose. The model reads everything as a
  labelled block, so the note is read as the runtime talking - never as the
  human, and never as its own earlier conclusion. It is written with
  `origin: "resume"`, so the replay draws it as a status line rather than as
  something the human typed. `isInterrupted` scans back from the end and
  answers `false` once it finds a `turn.end` or one of those notes, so a
  resume that crashed before running a turn does not add the note twice.

  The alternative - pretending the turn never happened - invites the model
  to run the same side effects twice. The note is written to the file because
  the log's job is to record what the model saw.

### Resume and the prompt cache

MiniMax's cache is passive: server-side, matched as a prefix in the order
tools → system → history, effective from 512 input tokens, and expired
according to system load - the docs give no fixed TTL. Nothing about the
cache lives on the client, so resuming in a new process is not itself a
reason to miss. What matters is whether the first request after resume is
byte-identical to the prefix the server already holds.

The design makes that the normal case:
- `queue` and `message` events store the exact values given to
  `Conversation.append`, including the labelled block the model read, so
  replay reproduces the turns byte for byte.
- Thinking blocks are stored with their signatures and replayed in place,
  so assistant turns are identical too.
- The system prompt is unchanged as long as the app is; the header's
  `systemPromptHash` says when it is not.
- The interrupted-turn note is appended at the **end**. The old prefix is
  untouched: it still hits, and only the note is charged at the standard
  input price (it then becomes part of the new cached prefix).

Where the prefix does break, and what it costs:

| Change between record and resume           | First differing point               | Effect                                     |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------ |
| different model, or thinking stripped      | first assistant turn with reasoning | miss from there; often most of the session |
| updated app with a changed `SYSTEM_PROMPT` | token 0 (system precedes history)   | full miss on the first request             |
| time or load evicted the entry             | token 0                             | full miss once, then recached              |
| different API key / account                | token 0                             | no shared cache by definition              |
| `--effort` changed                         | none expected                       | effort is a request parameter, not history |

Two rules follow for the implementation:
- **Never edit history to tidy it.** The cache is the reward for
  append-only: rewriting an old message to fix formatting invalidates
  everything after it.
- **Never silently reuse an old system prompt** to save a cache hit. A stale
  prompt is a behavioural change disguised as an optimisation; if the hash
  differs, say so and send the current prompt.

M3.1-Flash offers no `cache_control`, so there is no way to pin the entry
across a long pause - a cold resume pays the full input once and then
recaches. The status bar already reports the hit rate; that is how a human
tells whether a resume was warm.

## 5. Listing

`--list-sessions` prints, per session:

```
20261023T191005Z-844430e2  19:10  MiniMax-M3.1-Flash  3 turns  add a cache to the loader
```

Listing reads the first 16 KB of each file and the mtime: enough for the
header and the opening events, never a full scan. The turn count is what
that head holds, and the first user message is shortened to 80 characters
with `…`. `updatedAt` comes from the file's mtime, which is why the list is
ordered by activity rather than by start time. A session with a `title`
event shows the title instead of the first line. Prefix matching is allowed
for `--resume 20261023`, and ambiguity is an error rather than a guess.

The first line the human said is found in the queue events of a v2 file and
in the human messages of a v1 file, because both kinds of file can still be
opened and listed.

## 6. Privacy and retention

- Sessions are `0600` in a `0700` directory. On Windows the mode is a no-op;
  the home directory's ACL is the protection.
- Credentials are never written. The API key and auth token live in the
  process environment and are not part of any event. The system prompt is
  not written either - only its hash.
- Everything a step reads _is_ written, including whatever a tool returned.
  That is the point of a session and also the risk; the README says so, and
  `--no-session` turns recording off for shared or CI machines.
- No automatic deletion or rotation. A session is a record; expiring records
  silently is how people lose work. Deleting one is a manual act - the files
  are ordinary files - and a `sessions prune --older-than` command would be a
  later, explicit one.

## 7. Size, and why there is no snapshot yet

A session's file is roughly the conversation plus thinking, written once -
not once per request - so a session that reaches the full 1M-token window is
on the order of 10-40 MB of JSONL. Streaming that at startup is tens of
milliseconds and needs no index.

The header reserves the idea of a `snapshot` event - `{ messages, upto }`
appended every N turns - for the day files grow large enough that replay is
slow, or for a future compaction feature that actually summarizes old turns.
Neither is needed now, and a snapshot that is merely a cache of what is
already in the file is a second source of truth waiting to disagree.

## 8. Code shape

Following the existing ports-and-adapters split:

```
src/
├── domain/
│   ├── ports/session.ts        SessionEvent, SessionWriter, SessionStore,
│   │                           SessionSummary, LoadedSession
│   ├── queue.ts                MessageQueue, QueueEntry, formatQueue
│   ├── session.ts              restoreConversation, summarise, isInterrupted
│   └── unit.ts                 the scanner that finds the step in a reply
├── adapters/
│   ├── session/jsonl-sessions.ts  JsonlSessionStore (create/open/list),
│   │                              JsonlSessionWriter (append/checkpoint/close)
│   └── toolkit/                read, ls, glob, edit, bash
├── app/
│   ├── replay-session.ts       events → UI events, for the transcript
│   └── agent.ts                one `remember(...)` helper beside the
│                               `conversation.append` call sites
└── cli/
    ├── args.ts                 --resume, --continue, --list-sessions,
    │                           --no-session
    └── main.ts                 resolve store → create or resume → wire in
```

The domain port stays file-agnostic:

```ts
export interface SessionWriter {
  readonly id: string;
  append(event: SessionEventInput): void;
  checkpoint(): void;
  close(): void;
}

export interface SessionStore {
  create(start: SessionStart): SessionWriter;
  open(idOrPrefix: string): LoadedSession; // { header, events, summary, writer, ignoredLines }
  list(): readonly SessionSummary[];
}
```

In the agent, logging and remembering happen at the same moment, so they
cannot drift:

```ts
function remember(
  deps: AgentDeps,
  conversation: Conversation,
  message: LlmMessage,
  origin: SessionMessageOrigin,
  meta: { usage?: LlmUsage; stopReason?: LlmStopReason } = {},
): void {
  if (message.text.length === 0) return; // the conversation drops it too
  conversation.append(message.role, message.text, message.thinking);
  deps.session?.append({ type: 'message', message, origin, ...meta });
}
```

The queue has its own line, and it is the same line the conversation gets:

```ts
function sendQueue(
  deps: AgentDeps,
  conversation: Conversation,
  entries: readonly QueueEntry[],
): void {
  deps.session?.append({ type: 'queue', entries });
  conversation.append('user', formatQueue(entries));
}
```

The rest of the loop records what has no message form: `step` when the step
names itself, `tool` for each call it made, `say` for what it said, `note`
for every status line, `turn.*` around the loop.

## 9. CLI

```
--resume <id>        continue a session (id prefix is enough)
--continue           continue the most recent session for this directory
--list-sessions      show sessions for this directory
--no-session         do not record this session
```

Starting without any of these creates a new session. Recording is on by
default: a tool whose value is the work it did should keep the work.

The status bar shows the last eight characters of the session id whenever a
session is being recorded - a new one as much as a resumed one - so two
terminals on the same project are not ambiguous:

```
~/GitHub/replagent · ⎇ master · MiniMax-M3.1-Flash · 844430e2   45.2k/1000k · 78% cached
```

`--no-session` removes the id, because there is no file for it to name.

## 10. Tests

The log is the contract, so the tests are about degradation and equality:
- **Round trip.** Write a turn through the store, open it again, and assert
  the events, the header, the summary and the reasoning blocks come back
  unchanged - signatures included.
- **The queue survives.** The human's words, the model's deposits and the
  errors round-trip with their origins, labels and all.
- **Rebuild.** `restoreConversation` reproduces the live `Conversation`,
  including the merge of consecutive same-role turns.
- **Torn tail.** A half-written last line is dropped; every complete event
  loads, `ignoredLines` stays zero, and the file is not rewritten.
- **Unknown event / unreadable line.** Each is skipped and counted, and the
  rest of the session still loads.
- **An older file.** A v1 header with a world and an `observation` line
  still opens: the events load, the observation is dropped without counting
  as damage, and a v1 header without a world is refused.
- **Model mismatch.** `restoreConversation(events, false)` keeps the turns
  and drops the thinking.
- **Interrupted turn.** `isInterrupted` is true after a bare `turn.start`,
  false after `turn.end`, and false when a resume note already explains it.
- **Concurrency.** A second open while a live lock exists is refused; a
  stale pid is stolen; an ambiguous id prefix is an error.
- **Permissions.** On POSIX, the file is `0600` and the directory `0700`.
  The check is skipped on Windows, where the mode is a no-op.
- **No secrets.** Not tested, and deliberately so at this layer: the writer
  only ever receives what the agent loop hands it, and the loop never reads
  the environment. If a future change passes a credential through, the
  round-trip tests will not catch it.

## 11. Decisions at a glance

| Question              | Decision                             | Why                                                        |
| --------------------- | ------------------------------------ | ---------------------------------------------------------- |
| Home or repo?         | `~/.replagent`                       | sessions hold whatever the agent read; repos should not    |
| One file per what?    | session                              | resume, share, delete are all per session                  |
| Format                | JSONL, append-only                   | crash-tolerant, greppable, no rewrite                      |
| Unit of persistence   | completed messages + semantic events | deltas are rendering, not history                          |
| Rebuild context from  | `queue` and `message` events         | equals what the model saw; display cannot drift the prompt |
| The queue in the log  | the entries, not the rendering       | the rendering is derived; the entries are the truth        |
| Thinking blocks       | stored whole with signature          | the provider rejects altered or unsigned thoughts          |
| Other model on resume | strip thinking from the request      | a signature is one endpoint's proof                        |
| Interrupted turn      | keep messages, add a resume note     | side effects may have happened; silence invites repeats    |
| Old files             | read v1, drop its observations       | a file is not damaged because it is old                    |
| Compaction            | none yet; `snapshot` reserved        | 10-40 MB files replay fast; second truth is a liability    |
| Deletion              | manual only                          | a record that expires silently is not a record             |

## 12. Open questions for the implementer

1. **Resume UX.** `--continue` picks the newest session in the directory. If
   that session's last turn never ended, resuming is still the right default;
   the CLI now says so before the first input, but a `/sessions` picker with
   the same warning is still missing.
2. **The queue in the listing.** A session's summary shows the first thing
   the human said. What the model concluded, and how many rounds it took to
   conclude it, are in the file but not in the list - a `--list-sessions` line
   that said "7 rounds, 3 tools" would help a human pick which of twenty
   files to open.
3. **`/sessions` in the TUI.** Listing and switching sessions without leaving
   the app is a natural follow-up, but it needs a UI contract (`/resume`
   input handling, clearing the transcript) that is out of scope here.

## 13. Suggested commit sequence

1. `feat(session): a conversation that outlives the process` - domain port +
   fold + JSONL store + round-trip and torn-tail tests.
2. `feat(cli): --resume, --continue, --list-sessions` - argument parsing,
   startup wiring, status bar id, lock.
3. `feat(session): the transcript repaints itself` - record and replay
   `step`/`tool`/`say`/`note`, interrupted-turn note, model-mismatch rule.
