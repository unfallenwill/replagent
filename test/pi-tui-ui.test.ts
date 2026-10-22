import type { ProgramStatus, Terminal } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { JsHighlighter } from '../src/adapters/format/js-highlight.js';
import { PiTuiUi } from '../src/adapters/tui/pi-tui-ui.js';

class FakeTerminal implements Terminal {
  output = '';
  onInput: ((data: string) => void) | undefined;

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
    return 80;
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

describe('PiTuiUi', () => {
  it('renders the transcript, not just the editor', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal });

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
    const ui = new PiTuiUi({ model: 'test-model', terminal });

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

  it('shows the code when the step is asked for', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal });

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

  it('colours the code when the step is asked for', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
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
    const ui = new PiTuiUi({ model: 'test-model', terminal });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const secret = "hidden";' });
    ui.emit({ type: 'step', name: 'look around', description: 'see what is here' });
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
    const ui = new PiTuiUi({ model: 'test-model', terminal });

    void ui.run();
    await tick();

    ui.emit({ type: 'user-message', text: '你好' });
    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: '打个招呼', description: '向用户问好' });
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

  it('shows a spinner while the agent is working', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    await tick(150);
    expect(plain(terminal.output)).toContain('working');

    ui.emit({ type: 'busy', busy: false });
    ui.stop();
  });

  it('turns a submitted line into an input event', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal });
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
    const ui = new PiTuiUi({ model: 'test-model', terminal });

    void ui.run();
    await tick();

    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code', text: 'finish("first")' });
    ui.emit({ type: 'step', name: 'first step', description: 'end the first turn' });
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
    const ui = new PiTuiUi({ model: 'test-model', terminal });

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
    const ui = new PiTuiUi({ model: 'test-model', terminal });

    void ui.run();
    await tick();

    ui.emit({ type: 'agent-code', text: 'const a = 1;' });
    ui.emit({ type: 'step', name: 'a step', description: 'do the thing' });
    ui.emit({ type: 'repl-log', text: 'a log line' });
    ui.emit({ type: 'repl-value', text: '42' });
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
    const ui = new PiTuiUi({ model: 'test-model', terminal });

    void ui.run();
    await tick();

    // turn 1: the model streams a tool call envelope, so the turn is
    // rejected and no code event is emitted for it.
    ui.emit({ type: 'busy', busy: true });
    ui.emit({ type: 'agent-code-delta', text: '<tool_call>{"name": "fetch"}</tool_call>' });
    ui.emit({ type: 'repl-error', text: 'You emitted a tool call.' });
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

  it('interrupts on the first ctrl+c and quits on the second', async () => {
    const terminal = new FakeTerminal();
    let interrupts = 0;
    const ui = new PiTuiUi({
      model: 'test-model',
      terminal,
      onInterrupt: () => {
        interrupts += 1;
      },
    });

    const running = ui.run();
    await tick();

    terminal.onInput?.('\x03');
    await tick();

    expect(interrupts).toBe(1);
    expect(plain(terminal.output)).toContain('press ctrl+c again to quit');

    terminal.onInput?.('\x03');
    await expect(running).resolves.toBeUndefined();
  });

  it('scrolls the transcript with the mouse wheel', async () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'test-model', terminal });

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
