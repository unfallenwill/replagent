# replagent

A terminal agent that lives **inside a Node.js REPL**.

It has no tools. It has no functions, no APIs, no search. The REPL is the
only channel through which it can perceive or change anything — and
JavaScript is the only language it speaks.

Humans think in language; this agent thinks in JavaScript. Every reply it
produces is a program, executed verbatim in a persistent REPL. What it logs
and what its last expression evaluates to is all it ever learns.

```
you how many files are in this directory?

● count the files - read the directory and count what is in it
   log   scanning
   =>    42

There are 42 files in this directory.
```

## The protocol

There is no tool protocol, no tool schema, no parser for code fences. The
loop is four steps:
1. The model writes JavaScript. That is its entire reply.
2. The REPL runs it in a persistent context.
3. The observation — the value the step returned, or the error, plus the
   lines it logged if it failed — goes back to the model as the next turn.
4. Repeat, until the model calls `finish("...")`, which ends the turn and
   delivers the final answer.

A reply is one **step**: a name, a description of what it is for, and the
program.

```js
await step(
  'count the files',
  'read the directory and count what is in it',
  async (name, description) => {
    const entries = await fs.promises.readdir('.');
    return entries.length;
  },
);
```

Both the name and the description are required — the REPL refuses a step
without them, and it keeps them _before_ the program runs, so what the agent
intended is on record before what happened. The program gets both, so it can
label itself.

The step is the agent's working memory and it is gone when the step
returns: one reply is one thought, and one thought does not leave a mess
behind. That leaves two things that outlive a reply — the world model
below, and `globalThis` for the rare thing too big or too raw for it.

Because the REPL context persists, `require`d modules and `globalThis`
survive between turns.

If the model writes prose instead of JavaScript, the REPL returns a
`SyntaxError` and the model sees it. The protocol punishes nothing; it just
reports.

An observation cannot run away. The REPL keeps 8,000 characters of a line
and 16,000 of an observation, and says how much it cut, so the agent knows
it is looking at a part of the truth. The limit is generous on purpose:
while the agent is exploring it does not know yet what it is looking for,
and cutting the answer to "how big is this" off is cutting off the
exploration.

### Observations are marked

Every observation comes back wrapped in `<observation>` tags, so the model can
never confuse "the machine answered" with "the human spoke". Without that
marker the agent drifts back into being a chat assistant that happens to emit
JavaScript: it starts answering from what a language model is "supposed" to
say instead of from what it actually observed.

## The agent's world model

A prompt is a prior, not a mechanism. The rules in the system prompt say how
the agent should think about the world - what it is made of, what it may
know about it, what it is trying to achieve - but a rule that changes
nothing is a habit, not a capability. So the world the prompt describes has
to exist in the runtime too.

The agent keeps a model of the world, and the REPL keeps it for it
(`src/domain/world.ts`):

```js
world.observe('module count', 4, 'readdir src'); // what it saw
world.believe('the build is broken', true, 0.6, 'the tests failed');
world.plan('read the server log'); // what it will do
console.log(world.report()); // the whole model
```

Facts and beliefs are kept apart on purpose. A fact is something that was
observed, a belief is something that was concluded, and the second one can be
wrong. Both remember where they came from and when, because the world keeps
moving: a fact you observed ten minutes ago may no longer hold.

The model outlives the session. It is written to `.replagent/world.json` in
the working directory (`--world <path>` to put it somewhere else), so the
agent's experience survives its own restart, and the human can open the file
and read what the agent believes.

### The world does not tell you what it means

The world is a plain witness. It reports what happened - the value the step
returned, the error, and the lines it logged when it failed - and it stops
there. It does not check the agent's conclusions against reality, and it
does not decide what the agent should have been looking for.

The logs are the human's window into the run, not the agent's. The agent
gets the value a step returned, which is the one thing it asked for; when
a step fails, it gets the logs as well, because that is when the evidence
matters. What the agent wants to know, it returns.

That restraint is deliberate. While the agent is exploring it does not know
yet what it is looking for, and a world that guesses on its behalf would
only feed it a conclusion it had not earned. The comparison between what the
agent concluded and what actually happened is the agent's own work, done in
the one place it belongs: in the agent's head.

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

| Layer          | Contains                                                     | May depend on                            |
| -------------- | ------------------------------------------------------------ | ---------------------------------------- |
| `src/domain`   | ports, conversation, observation formatting, the world model | nothing (no third-party packages at all) |
| `src/app`      | the agent loop, the system prompt                            | `domain`                                 |
| `src/adapters` | Anthropic, `node:repl`, pi-tui, the world file               | `domain`                                 |
| `src/cli`      | argument parsing, wiring                                     | everything                               |

The rules are enforced in `.dependency-cruiser.cjs`:
- `domain` may not import `app`, `adapters`, `cli`, **or any npm package**
- `app` may not import `adapters` or `cli` (it only knows ports)
- `adapters` may not import `app` or `cli`
- nothing may import `cli`
- no cycles, no orphans, no dev-dependency leakage into `src/`

## Quality gates

`npm run check` runs all of them:

| Gate         | Tool                                   | What it enforces                                                                                                                                                                                         |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types        | `tsc --noEmit`                         | `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax` |
| Complexity   | ESLint `complexity`                    | McCabe cyclomatic complexity ≤ 10                                                                                                                                                                        |
| Complexity   | Biome `noExcessiveCognitiveComplexity` | cognitive complexity ≤ 15                                                                                                                                                                                |
| Architecture | `dependency-cruiser`                   | the layering above                                                                                                                                                                                       |
| Style        | Biome                                  | formatting and correctness linting                                                                                                                                                                       |
| Tests        | `vitest`                               | 207 tests, including real `node:repl` integration                                                                                                                                                        |

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
  --world <path>      where the agent keeps its model of the world
                      (default: .replagent/world.json in the working directory)
```

In the app: `/quit` leaves.

### Feedback

The transcript is a scrollable viewport (alternate screen) with the editor
pinned at the bottom. Everything the agent does appears there: your own
message is echoed, what the REPL logged, the value the step returned, the
errors, and the final answer.

The code the agent writes is folded away by default. What the transcript
shows is the step — its name and what it was for — because that is what the
transcript is for. The code, the logs and the value all belong to the step
that produced them, and they open and close with it: `ctrl+e` opens the
last step and closes it again. The keystroke's hint sits at the tail of
the fold itself, on the newest step, and says which way it goes; it leaves
when the step is no longer the newest one. The code is pretty-printed and
coloured for the terminal, and the colouring goes on after the formatting,
so it lands on the columns you are reading.

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
~/GitHub/replagent · ⎇ master · MiniMax-M3.1-Flash         45.2k/1000k · 78% cached
```

- On the left, where you are and who you are talking to: the working
  directory (read again as you go, so a `process.chdir` in a step shows
  up), the git branch when the directory is in a repository - `⎇` a branch
  name, or the short commit when HEAD is detached, read from `.git`
  without spawning git - and the model. A gateway's host appears too; the
  default endpoint does not, because you already know what it is.
- `45.2k/200k` is what the last request carried against the model's context
  window: the whole conversation, system prompt included, cache traffic
  counted too. That number is the session's real budget: every step sends
  it again, and it only ever grows. It turns yellow as the window fills.
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

Before the first request there is nothing to report, and the bar is just
the identity. The one thing that can take the bar over is the interrupt
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

Either credential is enough. The resolved endpoint and model are shown in
the status bar of the app, so you always know which one you are talking to.

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
  stream to turn it back into an observation;
- an incomplete expression comes back as `repl.Recoverable`, which is
  reported to the model as a `SyntaxError` so it can continue the statement.

Requires Node ≥ 22.12.
