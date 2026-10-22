import type { ProgramStatus, Terminal } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { PiTuiUi } from '../src/adapters/tui/pi-tui-ui.js';

class FakeTerminal implements Terminal {
  readonly writes: string[] = [];

  start(): void {
    // nothing to do
  }

  stop(): void {
    // nothing to do
  }

  async drainInput(): Promise<void> {
    // nothing to do
  }

  write(data: string): void {
    this.writes.push(data);
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

describe('PiTuiUi', () => {
  it('accepts every event the agent can emit', () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'claude-sonnet-4-5', terminal });

    ui.emit({ type: 'user-message', text: 'how many files are here?' });
    ui.emit({ type: 'agent-code-delta', text: 'const fs = require("node:fs");\n' });
    ui.emit({ type: 'agent-code-delta', text: 'fs.readdirSync(".").length' });
    ui.emit({ type: 'agent-code', text: 'fs.readdirSync(".").length' });
    ui.emit({ type: 'repl-log', text: 'scanning' });
    ui.emit({ type: 'repl-value', text: '42' });
    ui.emit({ type: 'repl-error', text: 'SyntaxError: unexpected token' });
    ui.emit({ type: 'final', text: 'there are 42 files' });
    ui.emit({ type: 'status', text: 'idle' });

    expect(true).toBe(true);
  });

  it('does not write to the real terminal', () => {
    const terminal = new FakeTerminal();
    const ui = new PiTuiUi({ model: 'claude-sonnet-4-5', terminal });

    ui.emit({ type: 'status', text: 'idle' });

    expect(terminal.writes).toEqual([]);
  });
});
