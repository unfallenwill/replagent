import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlSessionStore, projectSlug } from '../src/adapters/session/jsonl-sessions.js';
import type { SessionStart } from '../src/domain/ports/session.js';

const start: SessionStart = {
  model: 'MiniMax-M3.1-Flash',
  effort: 'max',
  maxTokens: 131_072,
  maxSteps: 24,
  world: '.replagent/world.json',
  systemPromptHash: 'sha256:test',
  agent: 'replagent',
};

let home: string;
let store: JsonlSessionStore;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'replagent-sessions-'));
  store = new JsonlSessionStore({ home, cwd: path.join(home, 'project') });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function openByPrefix(id: string): string {
  return path.join(store.directory, `${id}.jsonl`);
}

describe('JsonlSessionStore', () => {
  it('round-trips a session through the file', () => {
    const writer = store.create(start);
    writer.append({ type: 'turn.start' });
    writer.append({ type: 'message', origin: 'human', message: { role: 'user', text: 'hello' } });
    writer.append({
      type: 'message',
      origin: 'assistant',
      message: {
        role: 'assistant',
        text: '1;',
        thinking: [{ text: 'one is easiest', signature: 'sig' }],
      },
      usage: { input: 512, output: 12, cached: 480 },
      stopReason: 'end_turn',
    });
    writer.append({
      type: 'observation',
      observation: {
        ok: true,
        logs: [],
        value: '1',
        error: undefined,
        finalAnswer: undefined,
        step: undefined,
      },
    });
    writer.append({
      type: 'message',
      origin: 'observation',
      message: { role: 'user', text: '<observation>\n=> 1\n</observation>' },
    });
    writer.append({ type: 'turn.end', status: 'finished' });
    writer.close();

    const opened = store.open(writer.id);

    expect(opened.header).toMatchObject({
      id: writer.id,
      model: start.model,
      effort: start.effort,
      cwd: path.join(home, 'project'),
      v: 1,
      type: 'session',
    });
    expect(opened.events.map((event) => event.type)).toEqual([
      'turn.start',
      'message',
      'message',
      'observation',
      'message',
      'turn.end',
    ]);
    expect(opened.events[2]).toMatchObject({
      message: { thinking: [{ text: 'one is easiest', signature: 'sig' }] },
      usage: { input: 512, output: 12, cached: 480 },
      stopReason: 'end_turn',
    });
    expect(opened.summary).toMatchObject({ turns: 1, firstUserText: 'hello' });
    expect(opened.ignoredLines).toBe(0);

    opened.writer.close();
  });

  it('continues the sequence when a session is reopened', () => {
    const writer = store.create(start);
    writer.append({ type: 'turn.start' });
    writer.close();

    const opened = store.open(writer.id);
    opened.writer.append({ type: 'turn.end', status: 'finished' });
    opened.writer.close();

    const again = store.open(writer.id);
    expect(again.events.map((event) => event.seq)).toEqual([1, 2]);
    again.writer.close();
  });

  it('drops a torn last line instead of losing the session', () => {
    const writer = store.create(start);
    writer.append({ type: 'turn.start' });
    writer.close();
    appendFileSync(openByPrefix(writer.id), '{"seq":2,"at":"2026-10-23T19:10:00.000Z","type":');

    const opened = store.open(writer.id);

    expect(opened.events).toHaveLength(1);
    expect(opened.ignoredLines).toBe(0);
    // Reading must not rewrite the file: the torn tail is evidence.
    expect(readFileSync(openByPrefix(writer.id), 'utf8')).toMatch(/"type":$/);
    opened.writer.close();
  });

  it('skips a complete line that cannot be read, and keeps the rest', () => {
    const writer = store.create(start);
    writer.append({ type: 'turn.start' });
    writer.close();
    appendFileSync(openByPrefix(writer.id), '{"not":"an event"}\n');

    const opened = store.open(writer.id);

    expect(opened.events).toHaveLength(1);
    expect(opened.ignoredLines).toBe(1);
    opened.writer.close();
  });

  it('ignores an event type it does not know', () => {
    const writer = store.create(start);
    writer.append({ type: 'turn.start' });
    writer.close();
    appendFileSync(
      openByPrefix(writer.id),
      '{"seq":2,"at":"2026-10-23T19:10:00.000Z","type":"from-the-future","field":1}\n',
    );

    const opened = store.open(writer.id);

    expect(opened.events).toHaveLength(1);
    expect(opened.ignoredLines).toBe(1);
    opened.writer.close();
  });

  it('finds a session by a unique id prefix', () => {
    const writer = store.create(start);
    writer.close();

    const opened = store.open(writer.id.slice(0, -1));

    expect(opened.header.id).toBe(writer.id);
    opened.writer.close();
  });

  it('refuses an ambiguous prefix instead of guessing', () => {
    const first = store.create(start);
    first.close();
    const second = store.create(start);
    second.close();

    // Every id starts with the year, so this matches both.
    expect(() => store.open('2')).toThrow('ambiguous');
  });

  it('refuses a session another process has open', () => {
    const writer = store.create(start);

    // The lock is held by this very process, which is alive by definition.
    expect(() => store.open(writer.id)).toThrow('Session is open in process');
    writer.close();
  });

  it('takes over a lock whose process is gone', () => {
    const writer = store.create(start);
    writer.close();
    const lock = `${openByPrefix(writer.id)}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 999_999, at: '2026-10-23T19:10:00.000Z' }));

    const opened = store.open(writer.id);

    expect(opened.header.id).toBe(writer.id);
    opened.writer.close();
  });

  it('lists this directory’s sessions, most recently used first', () => {
    const first = store.create(start);
    first.append({ type: 'message', origin: 'human', message: { role: 'user', text: 'one' } });
    first.close();
    const second = store.create(start);
    second.close();

    const summaries = store.list();

    expect(summaries.map((summary) => summary.id).sort()).toEqual([first.id, second.id].sort());
    expect(summaries[0]?.model).toBe(start.model);
  });

  it('has no sessions before the first one is written', () => {
    expect(store.list()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps the file private', () => {
    const writer = store.create(start);
    writer.close();

    expect(statSync(openByPrefix(writer.id)).mode & 0o777).toBe(0o600);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  });
});

describe('projectSlug', () => {
  it('turns a path into a directory name without separators', () => {
    expect(projectSlug(path.join(home, 'project'))).not.toMatch(/[:\\/]/);
  });

  it.skipIf(process.platform !== 'win32')('names a windows path the way claude does', () => {
    expect(projectSlug('C:\\Users\\hicaosen\\GitHub\\replagent')).toBe(
      'C--Users-hicaosen-GitHub-replagent',
    );
  });
});
