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

js ▸ const fs = require("node:fs");
     fs.readdirSync(".").length

   log   scanning
   =>    42

answer ▸ There are 42 files in this directory.
```

## The protocol

There is no tool protocol, no tool schema, no parser for code fences. The
loop is four steps:
1. The model writes JavaScript. That is its entire reply.
2. The REPL runs it in a persistent context.
3. The observation — every `console.log` line, the value of the last
   expression, or the error — goes back to the model as the next turn.
4. Repeat, until the model calls `finish("...")`, which ends the turn and
   delivers the final answer.

Because the REPL context persists, `let`/`const`, required modules and
top-level `await` survive between turns. The REPL _is_ the agent's memory
and scratchpad.

If the model writes prose instead of JavaScript, the REPL returns a
`SyntaxError` and the model sees it. The protocol punishes nothing; it just
reports.

### Observations are marked

Every observation comes back wrapped in `<observation>` tags, so the model can
never confuse "the machine answered" with "the human spoke". Without that
marker the agent drifts back into being a chat assistant that happens to emit
JavaScript: it starts answering from what a language model is "supposed" to
say instead of from what it actually observed.

## Architecture

Four layers, with the dependency direction enforced by `dependency-cruiser`
rather than by convention:

```
   cli  ───────────►  app  ───────────►  domain
    │                    │                  ▲
    └────────►  adapters ───────────────────┘
```

| Layer          | Contains                                    | May depend on                            |
| -------------- | ------------------------------------------- | ---------------------------------------- |
| `src/domain`   | ports, conversation, observation formatting | nothing (no third-party packages at all) |
| `src/app`      | the agent loop, the system prompt           | `domain`                                 |
| `src/adapters` | Anthropic, `node:repl`, pi-tui              | `domain`                                 |
| `src/cli`      | argument parsing, wiring                    | everything                               |

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
| Tests        | `vitest`                               | 19 tests, including real `node:repl` integration                                                                                                                                                         |

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
```

In the app: `/quit` leaves.

### Feedback

The transcript is a scrollable viewport (alternate screen) with the editor
pinned at the bottom. Everything the agent does appears there: your own
message is echoed, the JavaScript it writes, what the REPL logged, the value
of the last expression, the errors, and the final answer.

While the agent is working the status line shows a spinner, so it is always
clear that a message went out and is being worked on.

### Scrolling

Mouse capture is on, so the wheel scrolls the transcript (without it the
terminal turns the wheel into cursor keys, and the editor walks through its
input history instead). Selecting text with the mouse copies it.

Keyboard: `pageUp` / `pageDown`, `ctrl+home` / `ctrl+end`, `ctrl+f` to
search the transcript.

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
