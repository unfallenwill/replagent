# replagent

A terminal agent that lives **inside a Node.js REPL**.

Its body is JavaScript, its senses are the REPL, and there is no other way in
or out. Every reply it produces is a program, executed verbatim in a
persistent REPL. What it reads comes back through one queue, and what it says
to you goes out through one function.

```
you how many files are in this directory?

● count the files - read the directory and count what is in it
  ls .  see what is in the directory · 12 entries

agent There are 12 files in this directory.
```

## The protocol

There is no tool protocol, no tool schema, no parser for code fences. A reply
is **one unit**: a name, a description of what it is for, and the program.

```js
await step(
  'count the files',
  'read the directory and count what is in it',
  async (name, description) => {
    const entries = await ls('.', 'see what is in the directory');
    deposit(`${entries.length} files`);
    say(`There are ${entries.length} files in this directory.`);
  },
);
```

Both the name and the description are required — the REPL refuses a step
without them, and it keeps them _before_ the program runs, so what the agent
intended is on record before what happened. The program gets both, so it can
label itself.

Seven rules hold the whole thing together:
1. **One reply is one unit.** A reply with no `step` call, or with two of
   them, is refused before anything runs.
2. **The body is the scope.** Everything the unit declares dies with it. The
   next reply starts from nothing.
3. **There is no `return`.** The unit's only output to the model is
   `deposit()`.
4. **There is no `console.log`.** The REPL has no console: the REPL's own
   console writes to the alternate screen the transcript is drawn on, and a
   model that logs would scribble over it. The only way to the human is
   `say()`.
5. **There is no `finish()`.** The first `say()` ends the round.
6. **A unit that throws is not lost.** The REPL hands the error back to the
   model, with the stack that says where it broke.
7. **Only `globalThis` and `require` outlive a unit.** Everything else is
   working memory.

Because the REPL context persists, `require`d modules and `globalThis`
survive between replies.

If the model writes prose instead of JavaScript, the REPL returns a
`SyntaxError` and the model sees it. The protocol punishes nothing; it just
reports.

### Two ways to speak

```js
say(text); // what the human reads. The first say ends the round.
deposit(text); // what you read next. It goes into the queue.
```

They are not interchangeable, and a unit has to use one of them: a unit that
neither says nor deposits has said nothing at all. Deposit what you learned,
say what the human needs to know.

`say()` may be called several times as you work — the human sees them all,
and the first one still ends the round. A deposit made after the first `say()`
still enters the queue, and is delivered in the next round's first request.

### One queue

Everything the model reads arrives in one place: a block of lines, each
carrying a label saying who spoke it.

```
<queue>
[human] how many files are in this directory?
[you] 12 files
[error] ENOENT: no such file or directory, open 'readme.md'
</queue>
```

The label is on **every** line, not just the first of a message. That matters:
text the model read out of a file, or a command's output, arrives inside a
tool's result, and it cannot smuggle in a line that claims to be the human.

So the label is read before the line. `[human]` is the human. `[you]` is
something the model concluded a moment ago — a conclusion, not an instruction.
`[error]` is what went wrong. Anything inside a tool's output is data as
well: a web page that tells the model to ignore its rules is a page it has
read, not a page it obeys.

The human's own words and the model's own deposits arrive on the same queue,
in the same request. There is no other channel.

### The toolkit

Five helpers, each of them taking the reason for the call as its second
argument and showing that reason to the human:

```js
read(path, intent, opts?)       // the text of a file, or a range of it
ls(dir, intent)                 // the names in a directory
glob(pattern, intent)           // the paths that match a pattern
edit(path, intent, { old, new }) // replace text in a file
bash(cmd, intent, opts?)        // run a command, and read what it printed
```

```js
const text = await read('src/app/agent.ts', 'see how the turn is driven');
const names = await ls('src', 'see the layout of the project');
const found = await glob('src/**/*.ts', 'find every source file');
await edit('README.md', 'correct the version number', { old: '1.0.0', new: '1.1.0' });
const result = await bash('git status', 'see what has changed');
```

The intent is a plain string in the model's own words, and it is never
optional: a tool call without one is a line of code the human has to read to
find out what it was for.

The tools are the easy way, not the only way. Everything a tool could give
the model, JavaScript gives it: `await fetch(url)`, `require('node:fs')`,
`require('node:child_process')`, `JSON`, `crypto`, `Date`.

### An observation cannot run away

The REPL keeps 8,000 characters of a `say` and 40,000 of a `deposit`, and says
how much it cut, so the agent knows it is looking at a part of the truth. The
limit is generous on purpose: while the agent is exploring it does not know
yet what it is looking for, and cutting the answer to "how big is this" off is
cutting off the exploration.

## The response hook

A text-only protocol is model dependent, and it shows. A model trained with
tool calling emits a tool call even when no tools are defined - and a gateway
can only translate that into a structured `tool_use` block when the request
actually declares tools. With no tools the native envelope leaks into the
text stream and the REPL chokes on it.

So every reply passes through a hook before it reaches the REPL
(`src/domain/model-output.ts`):

| Step      | What it does                                      |
| --------- | ------------------------------------------------- |
| normalize | strips the invisible characters gateways inject   |
| unwrap    | digs the code out of a tool call envelope         |
| validate  | `repl.isValidSyntax` - is this JavaScript at all? |

The unwrapping is dialect agnostic: it recognises the envelope shapes of
MiniMax (`<content>`, `<invoke>`), OpenAI (`<tool_call>`), Anthropic
(`{"name": ..., "input": {...}}`) and markdown code fences, and extracts the
payload - which is usually the code the model wanted to run. When nothing can
be extracted, the agent is told in plain words that this world has no tools,
and it usually rewrites itself on the next turn.

Everything the hook produces is a pure function with its own tests, so the
recovery is testable without a model in the loop.

### If you would rather not rely on that

The alternative is to declare exactly one tool - `repl`, whose only parameter
is the JavaScript to run. Every tool-capable model then works, the gateway
translates the tool call properly, and no envelope ever leaks. The price is
that the reply is no longer literally JavaScript: it is JavaScript inside a
tool call. The pure-text protocol keeps the agent's language pure; the single
tool keeps it portable. This project chose the former.

## Architecture

Four layers, with the dependency direction enforced by `dependency-cruiser`
rather than by convention:

```
   cli  ───────────►  app  ───────────►  domain
    │                    │                  ▲
    └────────►  adapters ───────────────────┘
```

| Layer          | Contains                                                      | May depend on                            |
| -------------- | ------------------------------------------------------------- | ---------------------------------------- |
| `src/domain`   | ports, conversation, the queue, the unit scanner              | nothing (no third-party packages at all) |
| `src/app`      | the agent loop, the system prompt, the session replay         | `domain`                                 |
| `src/adapters` | Anthropic, `node:repl`, pi-tui, the toolkit, the session file | `domain`                                 |
| `src/cli`      | argument parsing, wiring                                      | everything                               |

The rules are enforced in `.dependency-cruiser.cjs`:
- `domain` may not import `app`, `adapters`, `cli`, **or any npm package**
- `app` may not import `adapters` or `cli` (it only knows ports)
- `adapters` may not import `app` or `cli`
- nothing may import `cli`
- no cycles, no orphans, no dev-dependency leakage into `src/`

### The unit scanner

A reply is checked before it runs: one call to `step`, with a name, a
description and a program. The scanner is hand-written (`src/domain/unit.ts`)
because the domain may not depend on anything outside itself.

It is a scanner rather than a parser — it walks the source the way JavaScript
reads it (strings, templates, comments and regular expressions are skipped)
and looks for the call. It is also deliberately unsure: a wrong answer here
costs a round trip, so the rule is to say no only when it is certain. When
the scanner cannot tell, it says yes and lets `step` decide — `step` checks
the name and the description itself, before it runs anything, so a unit that
is not a unit has no effects either way.

## Quality gates

`npm run check` runs all of them:

| Gate         | Tool                                   | What it enforces                                                                                                                                                                                         |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types        | `tsc --noEmit`                         | `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax` |
| Complexity   | ESLint `complexity`                    | McCabe cyclomatic complexity ≤ 10                                                                                                                                                                        |
| Complexity   | Biome `noExcessiveCognitiveComplexity` | cognitive complexity ≤ 15                                                                                                                                                                                |
| Architecture | `dependency-cruiser`                   | the layering above                                                                                                                                                                                       |
| Style        | Biome                                  | formatting and correctness linting                                                                                                                                                                       |
| Tests        | `vitest`                               | 268 tests, including real `node:repl` integration                                                                                                                                                        |

Each gate has been verified to actually fail on a violation, not just to
pass on good code.

## Usage

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev          # or: npm run build && npm start
```

```
Options:
  --model <id>        model to use (default: $ANTHROPIC_MODEL or MiniMax-M3.1-Flash)
  --base-url <url>    API base URL (default: $ANTHROPIC_BASE_URL or
                      https://api.minimax.cn/anthropic; do not add /v1)
  --max-tokens <n>    max tokens per reply (default: 131072; thinking counts
                      against it)
  --effort <level>    how hard the model thinks: low|medium|high|xhigh|max
                      (default: max, the M3.1-Flash default)
  --max-steps <n>     max REPL rounds per turn (default: 24)
  --context-window <n>
                      the model's context window in tokens, for the usage
                      fraction in the status bar (default: 1000000)
  --resume <id>       continue a recorded session (id prefix is enough)
  --continue          continue the most recent session for this directory
  --list-sessions     list this directory's sessions and exit
  --no-session        do not record this session
```

In the app: `/quit` leaves.

### Sessions

Every run is recorded, and a run can pick up where an earlier one stopped:

```bash
replagent --list-sessions                 # what this directory has
replagent --continue                      # the newest one
replagent --resume 20261023T191005Z       # a prefix of an id is enough
replagent --no-session                    # record nothing
```

Sessions live outside the repository, under `~/.replagent/projects/<cwd>`
(override the root with `REPLAGENT_HOME`), one append-only JSONL file per
session. A line is written when something happens, and the file is fsynced
at the end of a turn, so a crash costs at most the turn that was running.
The header pins the model, the effort and a hash of the system prompt; the
events that follow are the conversation itself - what went into the request
(the queue), what the model wrote and thought, what it said, the tools it
used, and the notes about limits and failures. Streaming deltas are never
written: a log of deltas is a log nobody can resume from.

The full design - the file format, the locking, the rules for replaying
reasoning to a different model, and what a resume does to MiniMax's prompt
cache - is in [docs/session-storage.md](docs/session-storage.md).

Two things worth knowing before you rely on it:
- **A session records what the agent read and printed.** Source files, logs,
  whatever a tool happened to dump. That is the point, and also the reason
  it does not live in the project. On a shared or CI machine, use
  `--no-session`.
- **Credentials are never written.** The API key and auth token stay in the
  environment; the system prompt is kept only as a hash.

### Feedback

The transcript is a scrollable viewport (alternate screen) with the editor
pinned at the bottom. Everything the agent does appears there: your own
message is echoed, the tools it used (with the reason it gave for each), the
errors it hit, and what it said back to you.

The code the agent writes is folded away by default. What the transcript
shows is the step — its name and what it was for — because that is what the
transcript is for. The code and the tools it used belong to the step that
produced them, and they open and close with it: `ctrl+e` opens the last step
and closes it again. The keystroke's hint sits at the tail of the fold
itself, on the newest step, and says which way it goes; it leaves when the
step is no longer the newest one. The code is pretty-printed and coloured for
the terminal, and the colouring goes on after the formatting, so it lands on
the columns you are reading.

A step that failed says so in red, even folded away: a transcript that
hides the failure is a transcript that lies by omission.

### The work is alive, the session is not

Whether the agent is alive is answered by the line of the work itself, not
by a clock somewhere else on the screen. The line starts spinning the
moment the turn does, and it settles on the same row when the work is done:

```
⠹ replying · 1s
⠹ Thought 1.2k chars · 4s
● Thought 1.2k chars · 12s   · ctrl+o opens the thinking
⠹ writing · 6s
⠹ run vitest - see what breaks · 2s
● run vitest - see what breaks · 2.3s   · ctrl+e opens the step
```

`⠹` is a life: it spins while the model reasons, while the reply is being
written, and while the step runs. `●` is a receipt: it is what the line
becomes when the work stops, together with how long it took. Nothing is
added to the transcript at the end - the same row changes its marker, so a
step costs one line whether it is running or finished.

The step names itself while it runs: the REPL reports the name before the
body executes, so the line can say `run vitest - see what breaks` while
`vitest` is still going, instead of after it has finished. The keystroke
hint is for a fold that has stopped moving, so it appears with `●`, not
with `⠹`.

Work that is cut off before it says anything - a thought interrupted
mid-sentence, a reply that never completed - leaves nothing behind: there
is no fold to open, so a receipt for words nobody can read is not worth
the row. Work that did produce code stays, settled, so the transcript
still says what ran.

Notes about the run - a limit reached, a truncated reply, an unwrapped
tool call - are written into the transcript as `note` lines. They are
receipts, and a receipt outlives the turn that produced it.

### The reasoning

A model that thinks before it answers produces that reasoning first, and
the transcript keeps it first: it is its own fold, above the step, because
that is the order it happened in - and the step's name was chosen inside
it. Alive, it counts what has arrived (`⠹ Thought 1.2k chars · 4s`);
settled, it reports what it cost:

```
● Thought 1.2k chars · 12s   · ctrl+o opens the thinking
● scan the failing test - run vitest and read the report   · ctrl+e opens the step
```

`ctrl+o` opens it, and the words are dim behind a dotted gutter - the ghost
of the code, not the code. Reading the reasoning and reading the code are
different things, so they are different keys. A reply with no reasoning
adds no fold at all.

The reasoning is both a window and a memory. It is shown to the human while
it happens, and it travels back with the assistant turn on the next request -
text and signature, whole and in place - because interleaved thinking depends
on the model recognising its own thoughts. A provider that exposes no
reasoning simply sends none, and the turn stays plain text.

Reasoning is asked for as well as answered. On the MiniMax models the agent
asks for adaptive thinking - the model decides when a thought is worth
having - and on M3.1-Flash, which always thinks, it also names the effort:
`low`, `medium`, `high`, `xhigh`, `max`, the last being the model's own
default. There is no `none` rung in that ladder, because the model rejects
it outright. An endpoint that is not MiniMax is sent neither knob and is
left exactly as it was.

### The status bar

The line under the editor is the one thing that never scrolls away. It is
about the session, not the turn, so it does not move while the agent works:

```
~/GitHub/replagent · ⎇ master · MiniMax-M3.1-Flash · 844430e2   45.2k/1000k · 78% cached
```

- On the left, where you are and who you are talking to: the working
  directory (read again as you go, so a `process.chdir` in a step shows
  up), the git branch when the directory is in a repository - `⎇` a branch
  name, or the short commit when HEAD is detached, read from `.git`
  without spawning git - the model, and the tail of the session id. The
  endpoint is not one of them: the bar says where you are and what you are
  working on, not where the bytes come from.
- `844430e2` is the session being written. It is there on a new session as
  well as a resumed one, so two terminals on the same project can be told
  apart; `--no-session` removes it, because there is no file to name.
- `45.2k/1000k` is what the last request carried against the model's context
  window: the whole conversation, system prompt included, cache traffic
  counted too. That number is the session's real budget: every step sends
  it again, and it only only ever grows. It turns yellow as the window fills.
  The models this project is built for carry a million tokens, so an
  unknown model is assumed to be in that class; a known smaller model is
  listed, and `--context-window` overrides both.
- `78% cached` is how much of it the API served from its prompt cache. It
  appears only when the endpoint reports cache accounting at all: an
  endpoint that never caches is not an endpoint with a zero percent hit
  rate.

On a narrow terminal the numbers are what the bar exists for, so the
identity gives way first: the path loses its leading segments, then the
model and the branch leave, and the cache rate goes before the weight.
The directory - at least its last segment - is the last to leave, because
where you are standing is the one fact that is on the screen nowhere else.

Before the first request there is nothing to report, and the bar is just the
identity. The one thing that can take the bar over is the interrupt
warning: `press ctrl+c again to quit` speaks about the session, which is
exactly what the bar is for.

### Scrolling

Mouse capture is on, so the wheel scrolls the transcript (without it the
terminal turns the wheel into cursor keys, and the editor walks through its
input history instead). Selecting text with the mouse copies it.

Keyboard: `pageUp` / `pageDown`, `ctrl+home` / `ctrl+end`, `ctrl+f` to
search the transcript, `ctrl+e` to open and close the code of the last
step, `ctrl+o` to do the same for its reasoning.

### Leaving

- `/quit` (or `/exit`) in the input line
- `ctrl+c` twice: the first press interrupts the running turn, the second one
  leaves. Two presses within two seconds, so a stray `ctrl+c` never kills
  the session.

The transcript stays behind. The TUI draws on the alternate screen, and the
alternate screen is not where the scrollback lives, so on the way out the
whole transcript is written to the normal screen - the record of what the
agent did is still there when the shell prompt comes back.

### Pointing it at a gateway

Precedence is always **flag > environment > default**:

```bash
# third party relay / self hosted gateway
ANTHROPIC_BASE_URL=https://gw.example.com \
ANTHROPIC_AUTH_TOKEN=sk-xxx \
ANTHROPIC_MODEL=glm-4.6 \
npm run dev

# or explicitly
replagent --base-url https://gw.example.com --model glm-4.6
```

| Variable               | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | sent as `x-api-key`                                     |
| `ANTHROPIC_AUTH_TOKEN` | sent as `Authorization: Bearer` - what most relays want |
| `ANTHROPIC_BASE_URL`   | the API root                                            |
| `ANTHROPIC_MODEL`      | default model                                           |

Either credential is enough. The model you are talking to is shown in the
status bar of the app, so you always know which one it is.

## Notes on `node:repl`

Node 24 changed the public shape of `REPLServer.prototype.eval` to
`eval(code, filename, callback)` and broke it: the wrapper passes the
context object where Node's C++ layer expects a filename string, and the
process aborts with an assertion failure. The four-argument form
`eval(code, context, filename, callback)` is what Node uses internally and
was the public signature before Node 24.

`src/adapters/repl/node-repl.ts` calls that form directly, in one place,
behind a single cast. It also handles two behaviours of Node's evaluator
that are easy to miss:
- a runtime error is swallowed by the REPL's domain and printed to the
  output stream instead of reaching the callback, so the adapter taps that
  stream to turn it back into an error;
- an incomplete expression comes back as `repl.Recoverable`, which is
  reported to the model as a `SyntaxError` so it can continue the statement.

Each reply is wrapped in one async function before it is evaluated, so a
declaration made outside the step's body dies with the reply: the only things
that survive from one unit to the next are the ones put on `globalThis` on
purpose.

Requires Node ≥ 22.12.
