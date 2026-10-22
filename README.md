# replagent

A terminal agent that lives **inside a Node.js REPL**.

It has no tools. It has no functions, no APIs, no search. The REPL is the
only channel through which it can perceive or change anything — and
JavaScript is the only language it speaks.

Humans think in language; this agent thinks in JavaScript. Every reply it
produces is a program, executed verbatim in a persistent REPL. What it logs
and what its last expression evaluates to is all it ever learns.

```
you ▸ how many files are in this directory?

▶ count the files - read the directory and count what is in it
   log   scanning
   =>    42

answer ▸ There are 42 files in this directory.
```

## The protocol

There is no tool protocol, no tool schema, no parser for code fences. The
loop is four steps:
1. The model writes JavaScript. That is its entire reply.
2. The REPL runs it in a persistent context.
3. The observation — every `console.log` line, the value the step returned,
   or the error — goes back to the model as the next turn.
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

### The REPL checks the predictions

The other half of the loop is that a belief has to be able to be wrong. The
agent states what it expects, and the REPL compares it with what the run
actually produced:

```js
expect(4);
const files = await fs.promises.readdir('src');
files.length;
```

```
MISMATCH: expected 4, got 3
```

That line is not a failed run - it is the agent's model of the world being
wrong, and it is the cheapest information the agent will ever get. Without
it, an agent that guessed right looks exactly like an agent that understood
the world, and nothing in the transcript tells them apart.

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
| Tests        | `vitest`                               | 121 tests, including real `node:repl` integration                                                                                                                                                        |

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
  --model <id>        model to use (default: $ANTHROPIC_MODEL or claude-sonnet-4-5)
  --base-url <url>    API base URL (default: $ANTHROPIC_BASE_URL or api.anthropic.com)
  --max-tokens <n>    max tokens per reply (default: 8192)
  --max-steps <n>     max REPL rounds per turn (default: 24)
  --world <path>      where the agent keeps its model of the world
                      (default: .replagent/world.json in the working directory)
```

In the app: `/quit` leaves.

### Feedback

The transcript is a scrollable viewport (alternate screen) with the editor
pinned at the bottom. Everything the agent does appears there: your own
message is echoed, what the REPL logged, the value the step returned, the
errors, the mismatches between what the agent expected and what it got, and
the final answer.

The code the agent writes is folded away by default. What the transcript
shows is the step — its name and what it was for — because that is what the
transcript is for; `ctrl+e` opens the code of the last step and closes it
again. The code is pretty-printed for the transcript. Formatting is display
only: what runs is exactly what the model wrote.

### Scrolling

Mouse capture is on, so the wheel scrolls the transcript (without it the
terminal turns the wheel into cursor keys, and the editor walks through its
input history instead). Selecting text with the mouse copies it.

Keyboard: `pageUp` / `pageDown`, `ctrl+home` / `ctrl+end`, `ctrl+f` to
search the transcript, `ctrl+e` to open and close the code of the last step.

### Leaving

- `/quit` (or `/exit`) in the input line
- `ctrl+c` twice: the first press interrupts the running turn, the second one
  leaves. Two presses within two seconds, so a stray `ctrl+c` never kills
  the session.

### Pointing it at a gateway

Precedence is always **flag > environment > default**:

```bash
# third party relay / self hosted gateway
ANTHROPIC_BASE_URL=https://gw.example.com/v1 \
ANTHROPIC_AUTH_TOKEN=sk-xxx \
ANTHROPIC_MODEL=glm-4.6 \
npm run dev

# or explicitly
replagent --base-url https://gw.example.com/v1 --model glm-4.6
```

| Variable               | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | sent as `x-api-key`                                     |
| `ANTHROPIC_AUTH_TOKEN` | sent as `Authorization: Bearer` - what most relays want |
| `ANTHROPIC_BASE_URL`   | the API root                                            |
| `ANTHROPIC_MODEL`      | default model                                           |

Either credential is enough. The resolved endpoint and model are shown in
the header of the app, so you always know which one you are talking to.

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
