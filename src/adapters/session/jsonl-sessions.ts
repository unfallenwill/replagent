import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  type LlmMessage,
  type LlmThinkingBlock,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../../domain/ports/llm.js';
import type {
  LoadedSession,
  SessionEvent,
  SessionEventInput,
  SessionHeader,
  SessionMessageOrigin,
  SessionStart,
  SessionStore,
  SessionSummary,
  SessionTurnStatus,
  SessionWriter,
} from '../../domain/ports/session.js';
import type { QueueEntry } from '../../domain/queue.js';
import { summarise } from '../../domain/session.js';

/** How much of a file a listing reads: the header and the first few events. */
const HEAD_BYTES = 16 * 1024;

const STOP_REASONS = ['end_turn', 'max_tokens', 'stop_sequence', 'other'] as const;
const TURN_STATUSES: readonly SessionTurnStatus[] = [
  'finished',
  'cancelled',
  'limit',
  'rejected',
  'error',
  'idle',
];
const ORIGINS: readonly SessionMessageOrigin[] = ['human', 'assistant', 'observation', 'resume'];
const QUEUE_ORIGINS = ['human', 'model', 'error'] as const;

/**
 * Event types an older file had and this one does not write.
 *
 * A v1 file's observation is read and dropped: the transcript it belonged to
 * is gone, but the line is not damage.
 */
const LEGACY_EVENT_TYPES: ReadonlySet<string> = new Set(['observation']);

export interface JsonlSessionStoreOptions {
  /** The replagent home, `~/.replagent` by default. */
  readonly home?: string;
  /** The project directory a session belongs to. Defaults to the cwd. */
  readonly cwd?: string;
}

/**
 * Where the agent keeps its sessions.
 *
 * One directory per project, one append-only file per session, laid out the
 * way Claude Code lays out its own: `projects/<escaped cwd>/<id>.jsonl`. A
 * session holds everything the agent read, so it lives in the human's home,
 * not in the repository it is about.
 */
export class JsonlSessionStore implements SessionStore {
  readonly #directory: string;
  readonly #cwd: string;

  constructor(options: JsonlSessionStoreOptions = {}) {
    const home = options.home ?? replagentHome();
    this.#cwd = path.resolve(options.cwd ?? process.cwd());
    this.#directory = path.join(home, 'projects', projectSlug(this.#cwd));
  }

  /** The project's session directory. */
  get directory(): string {
    return this.#directory;
  }

  create(start: SessionStart): SessionWriter {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const now = new Date();
    const id = newId(now);
    const file = path.join(this.#directory, `${id}.jsonl`);
    acquireLock(file);
    try {
      const header: SessionHeader = {
        ...start,
        v: 2,
        type: 'session',
        id,
        at: now.toISOString(),
        cwd: this.#cwd,
      };
      writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 });
      return new JsonlSessionWriter(file, id, openSync(file, 'a'), 0);
    } catch (error) {
      releaseLock(file);
      throw error;
    }
  }

  open(idOrPrefix: string): LoadedSession {
    const file = this.#resolve(idOrPrefix);
    acquireLock(file);
    try {
      return this.#load(file);
    } catch (error) {
      releaseLock(file);
      throw error;
    }
  }

  list(): readonly SessionSummary[] {
    const summaries = sessionFiles(this.#directory).flatMap((name) => {
      const file = path.join(this.#directory, name);
      try {
        return [this.#summarise(file)];
      } catch {
        return [];
      }
    });
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  #load(file: string): LoadedSession {
    const id = path.basename(file, '.jsonl');
    const parsed = parseSession(readFileSync(file, 'utf8'));
    if (parsed.header === undefined) {
      throw new Error(`Not a replagent session: ${file}`);
    }
    const updatedAt = statSync(file).mtime.toISOString();
    return {
      header: parsed.header,
      events: parsed.events,
      summary: summarise(parsed.header, parsed.events, updatedAt),
      ignoredLines: parsed.ignored,
      writer: new JsonlSessionWriter(file, id, openSync(file, 'a'), lastSeq(parsed.events)),
    };
  }

  #summarise(file: string): SessionSummary {
    const text = readHead(file);
    const parsed = parseSession(text);
    if (parsed.header === undefined) {
      throw new Error(`Not a replagent session: ${file}`);
    }
    return summarise(parsed.header, parsed.events, statSync(file).mtime.toISOString());
  }

  #resolve(idOrPrefix: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(idOrPrefix)) {
      throw new Error(`Not a session id: ${idOrPrefix}`);
    }
    const exact = path.join(this.#directory, `${idOrPrefix}.jsonl`);
    if (existsSync(exact)) {
      return exact;
    }
    const matches = sessionFiles(this.#directory)
      .filter((name) => name.startsWith(idOrPrefix))
      .map((name) => path.join(this.#directory, name));
    if (matches.length === 1 && matches[0] !== undefined) {
      return matches[0];
    }
    if (matches.length === 0) {
      throw new Error(`No session matches "${idOrPrefix}" in ${this.#directory}`);
    }
    throw new Error(`"${idOrPrefix}" is ambiguous: ${matches.length} sessions match`);
  }
}

/** One open session file: appends events, keeps its own sequence. */
class JsonlSessionWriter implements SessionWriter {
  readonly id: string;
  readonly #file: string;
  readonly #fd: number;
  #seq: number;
  #closed = false;

  constructor(file: string, id: string, fd: number, seq: number) {
    this.#file = file;
    this.id = id;
    this.#fd = fd;
    this.#seq = seq;
  }

  append(event: SessionEventInput): void {
    if (this.#closed) {
      throw new Error(`Session ${this.id} is closed.`);
    }
    const line = `${JSON.stringify({ seq: this.#seq + 1, at: new Date().toISOString(), ...event })}\n`;
    writeAll(this.#fd, line);
    this.#seq += 1;
  }

  checkpoint(): void {
    if (!this.#closed) {
      fsyncSync(this.#fd);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    closeSync(this.#fd);
    releaseLock(this.#file);
  }
}

/** The replagent home: `$REPLAGENT_HOME`, else `~/.replagent`. */
export function replagentHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['REPLAGENT_HOME'];
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.replagent');
}

/**
 * A directory name for a project, with the same shape Claude Code uses:
 * the absolute path with separators and the drive colon turned into `-`.
 */
export function projectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[:\\/]/g, '-');
}

/** The time-ordered id of a new session. */
function newId(now: Date): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

function sessionFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

/** The first bytes of a file, enough for a header and the first user turn. */
function readHead(file: string): string {
  const size = statSync(file).size;
  const length = Math.min(size, HEAD_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written === 0) {
      throw new Error('Could not write the session file.');
    }
    offset += written;
  }
}

function lastSeq(events: readonly SessionEvent[]): number {
  return events.at(-1)?.seq ?? 0;
}

/** Take the lock next to a session file, or explain who holds it. */
function acquireLock(file: string): void {
  const lock = `${file}.lock`;
  if (tryCreateLock(lock)) {
    return;
  }
  const pid = readLockPid(lock);
  if (pid !== undefined && isAlive(pid)) {
    throw new Error(`Session is open in process ${pid} (${path.basename(file)}).`);
  }
  // A lock whose process is gone is debris from a crash, not a claim.
  rmSync(lock, { force: true });
  if (!tryCreateLock(lock)) {
    throw new Error(`Could not lock ${path.basename(file)}.`);
  }
}

function tryCreateLock(lock: string): boolean {
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function releaseLock(file: string): void {
  rmSync(`${file}.lock`, { force: true });
}

function readLockPid(lock: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(lock, 'utf8'));
    if (isRecord(raw) && typeof raw['pid'] === 'number') {
      return raw['pid'];
    }
  } catch {
    // A lock we cannot read is a lock nobody is holding properly.
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface ParsedSession {
  readonly header: SessionHeader | undefined;
  readonly events: readonly SessionEvent[];
  readonly ignored: number;
}

/**
 * Read a file anything could have written to it.
 *
 * The last line is dropped before parsing: a file that does not end in a
 * newline ends in a write that was cut off, and a torn tail is evidence, not
 * an event. Lines that do not parse are counted and skipped - one bad line
 * must not cost the session.
 */
function parseSession(text: string): ParsedSession {
  const lines = text.split('\n');
  lines.pop();
  const events: SessionEvent[] = [];
  let header: SessionHeader | undefined;
  let ignored = 0;

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const raw = tryParse(line);
    if (index === 0) {
      header = asHeader(raw);
      if (header === undefined) {
        ignored += 1;
      }
      continue;
    }
    const event = asEvent(raw);
    if (event === undefined) {
      if (!isLegacyEvent(raw)) {
        ignored += 1;
      }
      continue;
    }
    events.push(event);
  }

  return { header, events, ignored };
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The header fields that are plain strings. */
const HEADER_STRINGS = ['id', 'at', 'cwd', 'model', 'systemPromptHash', 'agent'] as const;

/** The numbers a header carries. */
interface HeaderFields {
  readonly effort: ReasoningEffort;
  readonly maxTokens: number;
  readonly maxSteps: number;
}

/** Whether the header has every field it needs, and what they are. */
function headerFields(raw: Record<string, unknown>): HeaderFields | undefined {
  const effort = asOneOf(raw['effort'], REASONING_EFFORTS);
  const maxTokens = raw['maxTokens'];
  const maxSteps = raw['maxSteps'];
  if (effort === undefined || typeof maxTokens !== 'number' || typeof maxSteps !== 'number') {
    return undefined;
  }
  if (!HEADER_STRINGS.every((key) => typeof raw[key] === 'string')) {
    return undefined;
  }
  return { effort, maxTokens, maxSteps };
}

/** The schema version a file was written with. */
function asVersion(raw: unknown): 1 | 2 | undefined {
  return raw === 1 || raw === 2 ? raw : undefined;
}

function asHeader(raw: unknown): SessionHeader | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const version = asVersion(raw['v']);
  if (version === undefined || raw['type'] !== 'session') {
    return undefined;
  }
  const fields = headerFields(raw);
  if (fields === undefined) {
    return undefined;
  }
  // A v1 file always named a world. A v2 file has none to name.
  const world = raw['world'];
  if (version === 1 && typeof world !== 'string') {
    return undefined;
  }
  return {
    v: version,
    type: 'session',
    id: raw['id'] as string,
    at: raw['at'] as string,
    cwd: raw['cwd'] as string,
    model: raw['model'] as string,
    effort: fields.effort,
    maxTokens: fields.maxTokens,
    maxSteps: fields.maxSteps,
    ...(typeof world === 'string' ? { world } : {}),
    systemPromptHash: raw['systemPromptHash'] as string,
    agent: raw['agent'] as string,
  };
}

function asEvent(raw: unknown): SessionEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { seq, at, type } = raw;
  if (typeof seq !== 'number' || typeof at !== 'string' || typeof type !== 'string') {
    return undefined;
  }
  const body = asEventBody(type, raw);
  return body === undefined ? undefined : { ...body, seq, at };
}

type EventBodyParser = (raw: Record<string, unknown>) => SessionEventInput | undefined;

/** Every event type the log knows, and how to read its body. */
const EVENT_BODIES: Readonly<Record<string, EventBodyParser>> = {
  'turn.start': () => ({ type: 'turn.start' }),
  'turn.end': turnEndBody,
  message: asMessageEvent,
  queue: queueBody,
  step: stepBody,
  tool: toolBody,
  say: textBody('say'),
  note: textBody('note'),
  title: textBody('title'),
};

function asEventBody(type: string, raw: Record<string, unknown>): SessionEventInput | undefined {
  const parser = EVENT_BODIES[type];
  return parser === undefined ? undefined : parser(raw);
}

function turnEndBody(raw: Record<string, unknown>): SessionEventInput | undefined {
  const status = asOneOf(raw['status'], TURN_STATUSES);
  return status === undefined ? undefined : { type: 'turn.end', status };
}

function stepBody(raw: Record<string, unknown>): SessionEventInput | undefined {
  const name = raw['name'];
  const description = raw['description'];
  return typeof name === 'string' && typeof description === 'string'
    ? { type: 'step', name, description }
    : undefined;
}

function toolBody(raw: Record<string, unknown>): SessionEventInput | undefined {
  const tool = raw['tool'];
  const intent = raw['intent'];
  const detail = raw['detail'];
  return typeof tool === 'string' && typeof intent === 'string' && typeof detail === 'string'
    ? { type: 'tool', tool, intent, detail }
    : undefined;
}

function queueBody(raw: Record<string, unknown>): SessionEventInput | undefined {
  const entries = asQueueEntries(raw['entries']);
  return entries === undefined ? undefined : { type: 'queue', entries };
}

function asQueueEntries(raw: unknown): QueueEntry[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entries: QueueEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const origin = asOneOf(entry['origin'], QUEUE_ORIGINS);
    const text = entry['text'];
    if (origin === undefined || typeof text !== 'string') {
      return undefined;
    }
    entries.push({ origin, text });
  }
  return entries;
}

function textBody(type: 'say' | 'note' | 'title'): EventBodyParser {
  return (raw) => {
    const text = raw['text'];
    return typeof text === 'string' ? { type, text } : undefined;
  };
}

function asMessageEvent(raw: Record<string, unknown>): SessionEventInput | undefined {
  const message = asMessage(raw['message']);
  const origin = asOneOf(raw['origin'], ORIGINS);
  if (message === undefined || origin === undefined) {
    return undefined;
  }
  const usage = asUsage(raw['usage']);
  const stopReason = asOneOf(raw['stopReason'], STOP_REASONS);
  return {
    type: 'message',
    message,
    origin,
    ...(usage !== undefined ? { usage } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function asMessage(raw: unknown): LlmMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const role = raw['role'];
  const text = raw['text'];
  if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string') {
    return undefined;
  }
  const thinking = asThinking(raw['thinking']);
  if (thinking === undefined) {
    return undefined;
  }
  return { role, text, ...(thinking.length > 0 ? { thinking } : {}) };
}

/** The reasoning blocks, or an empty list when the field is absent. */
function asThinking(raw: unknown): LlmThinkingBlock[] | undefined {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const blocks: LlmThinkingBlock[] = [];
  for (const block of raw) {
    if (!isRecord(block) || typeof block['text'] !== 'string') {
      return undefined;
    }
    const signature = block['signature'];
    blocks.push({
      text: block['text'],
      ...(typeof signature === 'string' ? { signature } : {}),
    });
  }
  return blocks;
}

function asUsage(raw: unknown): { input: number; output: number; cached?: number } | undefined {
  if (!isRecord(raw) || typeof raw['input'] !== 'number' || typeof raw['output'] !== 'number') {
    return undefined;
  }
  const cached = raw['cached'];
  return {
    input: raw['input'],
    output: raw['output'],
    ...(typeof cached === 'number' ? { cached } : {}),
  };
}

function asOneOf<T extends string>(raw: unknown, values: readonly T[]): T | undefined {
  return values.find((candidate) => candidate === raw);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null;
}

/** Whether the line was an event type this version no longer writes. */
function isLegacyEvent(raw: unknown): boolean {
  return isRecord(raw) && typeof raw['type'] === 'string' && LEGACY_EVENT_TYPES.has(raw['type']);
}
