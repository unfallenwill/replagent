import type { QueueEntry } from '../queue.js';
import type { LlmMessage, LlmStopReason, LlmUsage, ReasoningEffort } from './llm.js';

/**
 * A conversation that outlives the process.
 *
 * The record has two kinds of truth in it. `message` and `queue` events are
 * normative: they are exactly what went into the conversation, and replaying
 * them rebuilds the context the model had. Everything else - steps, tools,
 * what was said, notes, turn boundaries - is for the human reading the
 * session afterwards.
 *
 * The file records what the model saw, not what the terminal drew.
 */

/** Why the turn ended. Used to tell a finished run from one that was cut off. */
export type SessionTurnStatus =
  | 'finished'
  | 'cancelled'
  | 'limit'
  | 'rejected'
  | 'error'
  /** The turn ran out of things to send: the queue was empty. */
  | 'idle';

/**
 * Where a message came from. A model's own words are not the human speaking.
 *
 * `human` and `observation` are v1: in v2 the human's words live in the
 * queue, and what the model concluded lives there too.
 */
export type SessionMessageOrigin = 'human' | 'assistant' | 'observation' | 'resume';

/** What a new session is told about itself. The store fills in id, time and cwd. */
export interface SessionStart {
  readonly model: string;
  readonly effort: ReasoningEffort;
  readonly maxTokens: number;
  readonly maxSteps: number;
  /** The system prompt's hash, so a later resume can see that it moved. */
  readonly systemPromptHash: string;
  readonly agent: string;
}

/** The first line of every session file. */
export interface SessionHeader extends SessionStart {
  /**
   * The schema version of the file, not of the app.
   *
   * A v1 file has a world and its own event types; a v2 file has the queue.
   */
  readonly v: 1 | 2;
  readonly type: 'session';
  readonly id: string;
  readonly at: string;
  readonly cwd: string;
  /** A v1 file's world path. Read for compatibility; a v2 file has none. */
  readonly world?: string;
}

export type SessionEventInput =
  | { readonly type: 'turn.start' }
  | {
      readonly type: 'message';
      readonly message: LlmMessage;
      readonly origin: SessionMessageOrigin;
      readonly usage?: LlmUsage;
      readonly stopReason?: LlmStopReason;
    }
  /**
   * What went into the request.
   *
   * The entries are kept, not the text that was rendered from them, so a
   * resume rebuilds the request exactly - labels and all.
   */
  | { readonly type: 'queue'; readonly entries: readonly QueueEntry[] }
  | { readonly type: 'step'; readonly name: string; readonly description: string }
  | {
      readonly type: 'tool';
      readonly tool: string;
      readonly intent: string;
      readonly detail: string;
    }
  | { readonly type: 'say'; readonly text: string }
  | { readonly type: 'note'; readonly text: string }
  | { readonly type: 'turn.end'; readonly status: SessionTurnStatus }
  | { readonly type: 'title'; readonly text: string };

/** An event as it sits in the file: the payload plus its place in the log. */
export type SessionEvent = SessionEventInput & {
  readonly seq: number;
  readonly at: string;
};

/** What a listing needs, without reading the conversation. */
export interface SessionSummary {
  readonly id: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly model: string;
  readonly turns: number;
  /** The first thing the human said, shortened for a list. */
  readonly firstUserText?: string;
  /** A human's name for the session, when one was given. */
  readonly title?: string;
}

export interface SessionWriter {
  readonly id: string;
  append(event: SessionEventInput): void;
  /** Make what has been written durable. Called at the end of a turn. */
  checkpoint(): void;
  close(): void;
}

export interface LoadedSession {
  readonly header: SessionHeader;
  readonly events: readonly SessionEvent[];
  readonly summary: SessionSummary;
  /** Lines that could not be read - a torn tail, or a stranger's edit. */
  readonly ignoredLines: number;
  readonly writer: SessionWriter;
}

export interface SessionStore {
  /** Start a session, returning the writer that appends to it. */
  create(start: SessionStart): SessionWriter;
  /** Open an existing session by id or unique id prefix. */
  open(idOrPrefix: string): LoadedSession;
  /** Summaries for this project, most recently used first. */
  list(): readonly SessionSummary[];
}
