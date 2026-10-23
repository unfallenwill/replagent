import type { ProgramStatus, Terminal } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { JsHighlighter } from '../src/adapters/format/js-highlight.js';
import { PiTuiUi } from '../src/adapters/tui/pi-tui-ui.js';
import type { Location } from '../src/adapters/workspace/location.js';

class FakeTerminal implements Terminal {
  output = '';
  onInput: ((data: string) => void) | undefined;
  columnCount = 80;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }

  stop(): void {
    // nothing to do
  }

  async drainInput(): Promise<void> {
    // nothing to do
  }

  write(data: string): void {
    this.output += data;
  }

  get columns(): number {
    return this.columnCount;
  }

  get rows(): number {
    return 24;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(): void {
    // nothing to do
  }

  hideCursor(): void {
    // nothing to do
  }

  showCursor(): void {
    // nothing to do
  }

  clearLine(): void {
    // nothing to do
  }

  clearFromCursor(): void {
    // nothing to do
  }

  clearScreen(): void {
    // nothing to do
  }

  setTitle(): void {
    // nothing to do
  }

  setProgress(): void {
    // nothing to do
  }

  setProgramStatus(_status: ProgramStatus): void {
    // nothing to do
  }
}

function plain(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences is the point
  const ansi = /\u001b\[[0-9;?]*[a-zA-Z]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences is the point
  const hyperlink = /\u001b\]8;;\u0007/g;
  return output.replace(ansi, '').replace(hyperlink, '');
}

function tick(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A stand-in for the working directory, so the bar is the same everywhere. */
const atRepository: () => Location = () => ({ path: '~/GitHub/replagent', branch: 'master' });

describe('PiTuiUi', () => {
  it('renders the transcript, not just the editor', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'user-message', text: 'hello agent' });
    ui.emit({ type: 'agent-code', text: 'finish("hi")' });
    ui.emit({ type: 'step', name: 'say hi', description: 'finish the turn' });
    ui.emit({ type: 'final', text: 'hi there' });
    await tick();

    const screen = plain(terminal.output);
    expect(screen).toContain('hello agent');
    expect(screen).toContain('say hi');
    expect(screen).toContain('hi there');

    ui.stop();
  });

  it('folds the code away and shows only the name and the description', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const secret = "hidden";' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    await tick();

    const screen = plain(terminal.output);
    expect(screen).toContain('look around');
    expect(screen).toContain('see what is here');
    expect(screen).not.toContain('hidden');

    ui.stop();
  });

  it('keeps the keystroke hint at the tail of the fold, once the step has settled', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    // While the step runs the line says what is happening; the hint is for
    // a fold that has stopped moving.
    expect(
      ui.transcriptText.split('\n').find((line) => line.includes('look around')),
    ).not.toContain('ctrl+e');

    ui.emit({ type: 'exec-done' });
    await tick();

    // The affordance lives where the fold is, not down on the status line.
    const folded = ui.transcriptText.split('\n').find((line) => line.includes('look around'));
    expect(folded).toContain('ctrl+e opens the step');

    terminal.onInput?.('\x05');
    await tick(120);

    const opened = ui.transcriptText.split('\n').find((line) => line.includes('look around'));
    expect(opened).toContain('ctrl+e closes the step');

    ui.stop();
  });

  it('settles the step on the same line, and says how long it took', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code-delta', text: 'await step(' });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    await tick();

    const running = ui.transcriptText.split('\n').filter((line) => line.includes('look around'));
    expect(running).toHaveLength(1);
    // The marker only settles when the work does.
    expect(running[0]).not.toContain('●');

    ui.emit({ type: 'exec-done' });
    await tick();

    const settled = ui.transcriptText.split('\n').filter((line) => line.includes('look around'));
    expect(settled).toHaveLength(1);
    expect(settled[0]).toContain('●');

    ui.stop();
  });

  it('takes the hint back when the step is no longer the newest', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: 'first step', description: 'do the first thing' });
    ui.emit({ type: 'exec-done' });
    ui.emit({ type: 'agent-code', text: 'const b = 2;' });
    ui.emit({ type: 'step', name: 'second step', description: 'do the second thing' });
    ui.emit({ type: 'exec-done' });
    await tick();

    const lines = ui.transcriptText.split('\n');
    const first = lines.find((line) => line.includes('first step'));
    const second = lines.find((line) => line.includes('second step'));
    // The keystroke follows the newest step only, so only its fold carries
    // the hint.
    expect(first).not.toContain('ctrl+e');
    expect(second).toContain('ctrl+e opens the step');

    // The next turn leaves the keystroke nothing to act on, so the hint
    // goes with it.
    ui.emit({ type: 'busy', busy: true });
    await tick();

    const stale = ui.transcriptText.split('\n').find((line) => line.includes('second step'));
    expect(stale).not.toContain('ctrl+e');

    ui.stop();
  });

  it('folds the reasoning above the step, reporting only what it cost', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-thinking-delta', chars: 42 });
    ui.emit({ type: 'agent-thinking', text: 'The snapshot expects the old module count.' });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    await tick();

    const lines = ui.transcriptText.split('\n');
    const thoughtAt = lines.findIndex((line) => line.includes('Thought'));
    const stepAt = lines.findIndex((line) => line.includes('look around'));
    const thought = lines[thoughtAt] ?? '';

    expect(thought).toContain('Thought 42 chars');
    expect(thought).toContain('ctrl+o opens the thinking');
    // The thinking came first, and it is where it happened: above the step.
    expect(thoughtAt).toBeGreaterThan(-1);
    expect(thoughtAt).toBeLessThan(stepAt);
    // Shut, it reports its cost, not its words.
    expect(ui.transcriptText).not.toContain('The snapshot expects the old module count.');

    ui.stop();
  });

  it('counts the reasoning while it is still arriving', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-thinking-delta', chars: 1200 });
    await tick();

    const live = ui.transcriptText.split('\n').find((line) => line.includes('Thought'));
    expect(live).toContain('1.2k chars');
    // It is alive, so it is not reporting a duration yet in the settled
    // form, and it has no hint to offer.
    expect(live).not.toContain('●');
    expect(live).not.toContain('ctrl+o');

    ui.stop();
  });

  it('shows the reasoning when it is asked for', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-thinking-delta', chars: 42 });
    ui.emit({ type: 'agent-thinking', text: 'The snapshot expects the old module count.' });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    await tick();

    // ctrl+o is the reasoning's own key: it must not open the code.
    terminal.onInput?.('\x0f');
    await tick(120);

    const opened = ui.transcriptText;
    expect(opened).toContain('The snapshot expects the old module count.');
    expect(opened).toContain('ctrl+o closes the thinking');
    expect(opened).not.toContain('const a = 1;');

    ui.stop();
  });

  it('takes the thinking hint back when a newer thought arrives', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-thinking-delta', chars: 12 });
    ui.emit({ type: 'agent-thinking', text: 'first thought' });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'exec-done' });
    ui.emit({ type: 'agent-thinking-delta', chars: 13 });
    ui.emit({ type: 'agent-thinking', text: 'second thought' });
    ui.emit({ type: 'agent-code', text: 'const b = 2;' });
    await tick();

    const lines = ui.transcriptText.split('\n').filter((line) => line.includes('Thought'));
    expect(lines).toHaveLength(2);
    // The keystroke follows the newest thought only.
    expect(lines[0]).not.toContain('ctrl+o');
    expect(lines[1]).toContain('ctrl+o opens the thinking');

    ui.stop();
  });

  it('puts the work in the transcript, not in the bar', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'turn-progress', steps: 1, maxSteps: 24 });

    expect(ui.transcriptText).toContain('replying');
    expect(plain(ui.statusBarText)).not.toContain('replying');

    ui.emit({ type: 'agent-thinking-delta', chars: 0 });
    expect(ui.transcriptText).not.toContain('replying');
    expect(ui.transcriptText).toContain('Thought');

    // Once the code arrives, the line is about the step again.
    ui.emit({ type: 'agent-code-delta', text: 'const a' });
    expect(ui.transcriptText).toContain('writing');

    ui.stop();
  });

  it('does not move the bar while the agent works', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code-delta', text: 'await step(' });
    const before = ui.statusBarText;

    await tick(150);

    // The clocks are on the work. The bar is a statement, and a statement
    // does not tick.
    expect(ui.statusBarText).toBe(before);

    ui.stop();
  });

  it('shows the code when the step is asked for', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const secret = "hidden";' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    await tick();

    expect(plain(terminal.output)).not.toContain('hidden');

    terminal.onInput?.('\x05');
    await tick(120);

    expect(plain(terminal.output)).toContain('hidden');

    ui.stop();
  });

  it('opens the fold once per press, even when the release is reported too', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const secret = "hidden";' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    ui.emit({ type: 'exec-done' });
    await tick();

    // The Kitty keyboard protocol reports both edges of the key: ctrl+e
    // down, then ctrl+e up. Only the press is a keystroke.
    terminal.onInput?.('\u001b[101;5u');
    terminal.onInput?.('\u001b[101;5:3u');
    await tick(120);

    expect(plain(terminal.output)).toContain('hidden');

    ui.stop();
  });

  it('colours the code when the step is asked for', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: atRepository,
      highlighter: new JsHighlighter(),
    });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const answer = 42;' });
    ui.emit({ type: 'step', name: 'answer', description: 'the answer' });
    await tick();

    terminal.onInput?.('\x05');
    await tick(120);

    expect(terminal.output).toContain('\u001b[36mconst\u001b[0m');

    ui.stop();
  });

  it('shows the code below its step, not at the end of the transcript', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const secret = "hidden";' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
    ui.emit({ type: 'exec-done' });
    ui.emit({ type: 'final', text: 'the answer' });
    await tick();

    terminal.onInput?.('\x05');
    await tick(120);

    const transcript = ui.transcriptText;
    const step = transcript.indexOf('look around');
    const code = transcript.indexOf('hidden');
    const answer = transcript.indexOf('the answer');

    expect(step).toBeGreaterThan(-1);
    expect(code).toBeGreaterThan(step);
    // The code belongs to the step, so it comes before the answer that
    // followed it.
    expect(answer).toBeGreaterThan(code);

    ui.stop();
  });

  it('leaves the transcript on the screen when it stops', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'user-message', text: '你好' });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: '打个招呼', description: '向用户问好' });
    ui.emit({ type: 'exec-done' });
    ui.emit({ type: 'final', text: '你好！' });
    await tick();

    ui.stop();
    await tick(120);

    // The alternate screen goes away, so the transcript is written to the
    // normal screen, where the scrollback keeps it.
    const screen = plain(terminal.output);
    expect(screen).toContain('打个招呼');
    expect(screen).toContain('你好！');

    ui.stop();
  });

  it('says where the session is standing', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    expect(plain(ui.statusBarText)).toContain('~/GitHub/replagent · ⎇ master · test-model');

    ui.stop();
  });

  it('leaves the branch out when the directory is not a repository', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: () => ({ path: '~/scratch', branch: undefined }),
    });

    void ui.run();
    await tick();

    const bar = plain(ui.statusBarText);
    expect(bar).toContain('~/scratch · test-model');
    expect(bar).not.toContain('⎇');

    ui.stop();
  });

  it('shows the endpoint only when it is not the default one', async () => {
    const terminal = new FakeTerminal();
    const gateway = new PiTuiUi({
      model: 'test-model',
      endpoint: 'gw.example.com',
      terminal,
      location: atRepository,
    });

    expect(plain(gateway.statusBarText)).toContain('test-model · gw.example.com');
    gateway.stop();

    const direct = new PiTuiUi({
      model: 'test-model',
      endpoint: 'api.anthropic.com',
      terminal,
      location: atRepository,
    });

    expect(plain(direct.statusBarText)).not.toContain('api.anthropic.com');
    direct.stop();
  });

  it('shows what the conversation weighs, against the window it fits in', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: atRepository,
      contextWindow: 200_000,
    });

    void ui.run();
    await tick();

    ui.emit({ type: 'turn-usage', usage: { input: 45234, output: 1800, cached: 35280 } });
    await tick();

    const bar = plain(ui.statusBarText);
    expect(bar).toContain('45.2k/200k');
    expect(bar).toContain('78% cached');
    // The turn is over, and its output count is not a session fact.
    expect(bar).not.toContain('out');
    expect(bar).not.toContain('step ');

    ui.stop();
  });

  it('reports the weight alone when the window is not known', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'turn-usage', usage: { input: 45234, output: 1800, cached: 35280 } });
    await tick();

    // A wrong denominator is worse than no denominator.
    expect(plain(ui.statusBarText)).toContain('45.2k ctx');
    expect(plain(ui.statusBarText)).not.toContain('/200k');

    ui.stop();
  });

  it('reports no cache rate when the API reports no cache accounting', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: atRepository,
      contextWindow: 200_000,
    });

    void ui.run();
    await tick();

    ui.emit({ type: 'turn-usage', usage: { input: 1000, output: 50 } });
    await tick();

    const bar = plain(ui.statusBarText);
    expect(bar).toContain('1k/200k');
    expect(bar).not.toContain('cached');

    ui.stop();
  });

  it('marks the context when the window is running out', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: atRepository,
      contextWindow: 200_000,
    });

    void ui.run();
    await tick();

    ui.emit({ type: 'turn-usage', usage: { input: 190_000, output: 100 } });
    await tick();

    expect(ui.statusBarText).toContain('\u001b[33m190k/200k\u001b[0m');

    ui.stop();
  });

  it('writes the step budget as a note when it starts running out', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'turn-progress', steps: 21, maxSteps: 24 });
    ui.emit({ type: 'turn-progress', steps: 22, maxSteps: 24 });
    await tick();

    // Said once: a warning repeated every step is a warning nobody reads.
    const notes = ui.transcriptText.match(/21 of 24 steps used\./g) ?? [];
    expect(notes).toHaveLength(1);
    // The budget is a fact about the turn, and the turn's facts are in the
    // transcript; the bar keeps to the session.
    expect(plain(ui.statusBarText)).not.toContain('step');

    ui.stop();
  });

  it('keeps the status messages in the transcript', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'status', text: 'Stopped: reached the limit of 4 steps.' });
    await tick();

    // A receipt outlives the turn that produced it.
    expect(ui.transcriptText).toContain('note');
    expect(ui.transcriptText).toContain('Stopped: reached the limit of 4 steps.');
    expect(plain(ui.statusBarText)).not.toContain('Stopped');

    ui.stop();
  });

  it('gives up the bar items in ascending order of importance on a narrow terminal', async () => {
    const terminal = new FakeTerminal();
    terminal.columnCount = 30;
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: atRepository,
      contextWindow: 200_000,
    });

    void ui.run();
    await tick();

    ui.emit({ type: 'turn-usage', usage: { input: 45234, output: 1800, cached: 35280 } });
    await tick();

    const bar = plain(ui.statusBarText);
    // The weight is the last to leave; the identity gives up its parts
    // before the numbers do.
    expect(bar).toContain('45.2k/200k');
    expect(bar).not.toContain('cached');
    expect(bar).not.toContain('test-model');
    expect(bar).not.toContain('⎇');
    expect(bar).toContain('…/replagent');

    ui.stop();
  });

  it('turns a submitted line into an input event', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });
    let received: string | undefined;
    ui.onInput((text) => {
      received = text;
    });

    void ui.run();
    await tick();

    terminal.onInput?.('你好');
    await tick();
    terminal.onInput?.('\r');
    await tick();

    expect(received).toBe('你好');

    ui.stop();
  });

  it('gives every turn its own code block', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code', text: 'finish("first")' });
    ui.emit({ type: 'step', name: 'first step', description: 'end the first turn' });
    ui.emit({ type: 'exec-done' });
    ui.emit({ type: 'busy', busy: false });
    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code', text: 'finish("second")' });
    ui.emit({ type: 'step', name: 'second step', description: 'end the second turn' });
    await tick();

    const screen = plain(terminal.output);
    // Reusing a single code block would let the last turn overwrite the
    // label of the earlier ones, so the transcript would show "second" next
    // to the answer "first".
    expect(screen).toContain('first step');
    expect(screen).toContain('second step');

    ui.stop();
  });

  it('keeps the steps in the order they happened', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    // step 1: code, then the REPL rejects it
    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code-delta', text: 'console.log("first")' });
    ui.emit({ type: 'agent-code', text: 'console.log("first")' });
    ui.emit({ type: 'step', name: 'first step', description: 'log the first thing' });
    ui.emit({ type: 'repl-error', text: 'ERROR: first failure' });

    // step 2: the model writes code again, and it fails too
    ui.emit({ type: 'agent-code-delta', text: 'console.log("second")' });
    ui.emit({ type: 'agent-code', text: 'console.log("second")' });
    ui.emit({ type: 'step', name: 'second step', description: 'log the second thing' });
    ui.emit({ type: 'repl-error', text: 'ERROR: second failure' });
    await tick();

    const screen = plain(terminal.output);
    const first = screen.indexOf('first step');
    const second = screen.indexOf('second step');

    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);

    ui.stop();
  });

  it('folds the logs and the value into the step', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: 'a step', description: 'do the thing' });
    ui.emit({ type: 'repl-log', text: 'a log line' });
    ui.emit({ type: 'repl-value', text: '42' });
    ui.emit({ type: 'exec-done' });
    await tick();

    const collapsed = plain(terminal.output);
    expect(collapsed).toContain('a step');
    expect(collapsed).not.toContain('a log line');
    expect(collapsed).not.toContain('42');

    terminal.onInput?.('\x05');
    await tick(120);

    const opened = plain(terminal.output);
    expect(opened).toContain('a log line');
    expect(opened).toContain('42');

    ui.stop();
  });

  it('puts the code of the next turn below the error of the previous one', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    // turn 1: the model streams a tool call envelope, so the turn is
    // rejected and no code event is emitted for it.
    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code-delta', text: '<tool_call>{"name": "fetch"}</tool_call>' });
    ui.emit({ type: 'agent-code', text: '<tool_call>{"name": "fetch"}</tool_call>' });
    ui.emit({ type: 'repl-error', text: 'You emitted a tool call.' });
    terminal.onInput?.('\x05');
    await tick();
    ui.emit({ type: 'busy', busy: false });

    // turn 2: the model writes code again.
    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code-delta', text: 'console.log("second turn")' });
    ui.emit({ type: 'agent-code', text: 'console.log("second turn")' });
    ui.emit({ type: 'step', name: 'second turn', description: 'log something' });
    await tick();

    const screen = plain(terminal.output);
    const errorAt = screen.indexOf('You emitted a tool call.');
    const codeAt = screen.indexOf('second turn');

    expect(errorAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(-1);
    // The new code belongs below the error, not above it.
    expect(codeAt).toBeGreaterThan(errorAt);

    ui.stop();
  });

  it('leaves nothing behind for work that was cut off before it said anything', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-thinking-delta', chars: 400 });
    expect(ui.transcriptText).toContain('Thought 400 chars');

    // The turn was interrupted mid-thought: there is no reasoning to open,
    // so a receipt for words nobody can read is not worth the row.
    ui.emit({ type: 'busy', busy: false });
    await tick();

    expect(ui.transcriptText).not.toContain('Thought');

    ui.stop();
  });

  it('keeps a step that ran when the turn is interrupted afterwards', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code-delta', text: 'await step(' });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    await tick();

    // The code exists, so the transcript still says what was run.
    ui.emit({ type: 'busy', busy: false });
    await tick();

    expect(plain(ui.transcriptText)).toContain('● js');

    ui.stop();
  });

  it('interrupts on the first ctrl+c and quits on the second', async () => {
    const terminal = new FakeTerminal();
    let interrupts = 0;
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: atRepository,
      onInterrupt: () => {
        interrupts += 1;
      },
    });

    const running = ui.run();
    await tick();

    ui.emit({ type: 'turn-usage', usage: { input: 45234, output: 1800, cached: 35280 } });

    terminal.onInput?.('\x03');
    await tick();

    expect(interrupts).toBe(1);
    expect(plain(terminal.output)).toContain('press ctrl+c again to quit');
    // The warning is about the session, so it takes the bar, numbers and all.
    expect(plain(ui.statusBarText)).not.toContain('cached');

    terminal.onInput?.('\x03');
    await expect(running).resolves.toBeUndefined();
  });

  it('does not count the release of ctrl+c as a second press', async () => {
    const terminal = new FakeTerminal();
    let interrupts = 0;
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      location: atRepository,
      onInterrupt: () => {
        interrupts += 1;
      },
    });

    let finished = false;
    const running = ui.run().then(() => {
      finished = true;
    });
    await tick();

    terminal.onInput?.('\u001b[99;5u');
    await tick();
    terminal.onInput?.('\u001b[99;5:3u');
    await tick();

    // The key went down and came back up: that is one press, and the
    // session stays open waiting for the second one.
    expect(interrupts).toBe(1);
    expect(finished).toBe(false);
    expect(plain(ui.statusBarText)).toContain('press ctrl+c again to quit');

    ui.stop();
    await running;
  });

  it('scrolls the transcript with the mouse wheel', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal, location: atRepository });

    void ui.run();
    await tick();

    for (let index = 0; index < 60; index += 1) {
      ui.emit({ type: 'repl-log', text: `line ${index}` });
    }
    await tick(120);

    const before = ui.transcriptScrollTop;
    expect(before).toBeGreaterThan(0);

    // SGR mouse wheel up: button 64, column 10, row 10
    terminal.onInput?.('\x1b[<64;10;10M');
    await tick(120);

    expect(ui.transcriptScrollTop).toBeLessThan(before);

    ui.stop();
  });
});
