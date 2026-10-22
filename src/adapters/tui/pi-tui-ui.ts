import process from 'node:process';
import {
  type Component,
  Container,
  Editor,
  type EditorTheme,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  type SelectListTheme,
  type Terminal,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
} from '@earendil-works/pi-tui';
import type { CodeFormatter, CodeHighlighter } from '../../domain/ports/format.js';
import type { LlmUsage } from '../../domain/ports/llm.js';
import type { UiEvent, UiPort } from '../../domain/ports/ui.js';
import { bold, cyan, dim, green, red, yellow } from '../format/ansi.js';
import { elidePath, type Location, readLocation } from '../workspace/location.js';

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => `> ${text}`,
  selectedText: (text) => bold(text),
  description: (text) => dim(text),
  scrollInfo: (text) => dim(text),
  noMatch: (text) => dim(text),
};

const editorTheme: EditorTheme = {
  borderColor: (text) => dim(text),
  selectList: selectListTheme,
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const QUIT_CONFIRM_MS = 2000;

/**
 * The endpoint you get by saying nothing. Only an endpoint that is not this
 * one is worth a place in the bar.
 */
const DEFAULT_ENDPOINT = 'api.anthropic.com';

/**
 * How much of the step budget may be spent before the transcript says so.
 * The note is a receipt, not a countdown: it appears once.
 */
const NEAR_LIMIT = 0.85;

/** How full the context window may get before the number changes colour. */
const NEAR_CONTEXT = 0.8;

/** Between the two halves of the status bar. */
const BAR_SEPARATOR = dim(' · ');
/** The smallest gap the two halves of the bar may keep between them. */
const MIN_GAP = 2;
/** How often the directory and the branch are read again, in milliseconds. */
const LOCATION_REFRESH_MS = 1000;

/**
 * The reasoning, as the terminal reads it.
 *
 * Dim, and behind a dotted gutter: it is the ghost of the code, not the
 * code. The dotted line is how the eye tells the two apart without reading
 * a word, and it survives the colour being turned off.
 */
function thinkingBody(text: string): string {
  return text
    .split('\n')
    .map((line) => `${dim('┆')} ${dim(line)}`)
    .join('\n');
}

/**
 * A token count as a person reads it: `980`, `9.8k`, `45.2k`, `180k`.
 */
function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 100_000) {
    return `${Math.floor(count / 100) / 10}k`;
  }
  return `${Math.round(count / 1000)}k`;
}

/**
 * How much of the prompt the cache served, in percent - when the API
 * reports cache accounting at all. Without it there is no rate: an endpoint
 * that never caches is not an endpoint with a zero percent hit rate.
 */
function cacheRate(usage: LlmUsage): number | undefined {
  if (usage.cached === undefined || usage.input <= 0) {
    return undefined;
  }
  return Math.round((100 * usage.cached) / usage.input);
}

/** A duration in milliseconds, as a person reads it: `7s`, then `3m07s`. */
function formatSeconds(duration: number): string {
  const seconds = Math.floor(duration / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** The working directory as it is now, or a placeholder that cannot throw. */
function defaultLocation(): Location {
  try {
    return readLocation(process.cwd());
  } catch {
    return { path: '.', branch: undefined };
  }
}

export interface PiTuiOptions {
  readonly model: string;
  /** Terminal to render on. Defaults to the process terminal. */
  readonly terminal?: Terminal;
  /** Host the agent talks to, shown in the bar when it is not the default. */
  readonly endpoint?: string;
  /** The model's context window in tokens, for the context fraction. */
  readonly contextWindow?: number;
  /** Where the agent is standing. Read afresh as the bar updates. */
  readonly location?: () => Location;
  /** Capture mouse events so the wheel scrolls the transcript. Default: true. */
  readonly mouse?: boolean;
  /** Called when the user interrupts the running turn with the first ctrl+c. */
  readonly onInterrupt?: () => void;
  /** Pretty-prints the agent's code for display. */
  readonly formatter?: CodeFormatter;
  /** Colours the agent's code for display. */
  readonly highlighter?: CodeHighlighter;
}

/**
 * A step in the transcript.
 *
 * The human sees the title: the name the agent gave the step and what it
 * was for. Everything the step produced - the code, the logs, the value -
 * belongs to it, and opens and closes with it.
 *
 * The step is alive while it runs: the marker spins, the seconds move, and
 * the name arrives the moment the code names it. When the code is done the
 * line settles on the same row, so a step costs one line whether it is
 * running or finished.
 */
interface StepBlock {
  readonly header: Text;
  /** The code, once the reply is complete. Absent while it is being written. */
  code: Text | undefined;
  readonly group: Container;
  readonly details: Text[];
  /** `name - description`, once the code has said what the step is. */
  label: string | undefined;
  phase: 'writing' | 'running';
  expanded: boolean;
  failed: boolean;
  live: boolean;
  readonly startedAt: number;
  elapsed: number | undefined;
}

/**
 * The reasoning that came before a reply.
 *
 * It is its own fold, above the step, because that is the order it happened
 * in - and the step's name was chosen inside it. Alive, it counts what has
 * arrived so far; settled, it reports what it cost: how much and how long.
 */
interface ThoughtBlock {
  readonly header: Text;
  body: Text | undefined;
  readonly group: Container;
  expanded: boolean;
  live: boolean;
  readonly startedAt: number;
  chars: number;
  elapsed: number | undefined;
}

/**
 * The window into the agent.
 *
 * Everything the agent does shows up here: the JavaScript it writes, what the
 * REPL logged, what the last expression evaluated to, and the errors it has
 * to work through. The human types at the bottom.
 *
 * The renderer is the alternate screen: it owns a viewport, so the transcript
 * scrolls inside the window while the editor stays pinned at the bottom. The
 * plain main screen has no layout engine, and a scroll view inside it would
 * silently render nothing.
 *
 * Liveness belongs to the work: the thinking fold spins while the model
 * reasons, the step spins while it runs, and each line settles where it
 * stands. The bar underneath the editor shows only what outlives the work -
 * where the session is, who it is talking to, and what it now weighs - so it
 * never asks the eye to follow two clocks at once.
 */
export class PiTuiUi implements UiPort {
  readonly #tui: TuiAltScreen;
  readonly #document: Container;
  readonly #editor: Editor;
  /** The line under the editor: the session's standing, not the turn's. */
  readonly #bar: Component;
  readonly #options: PiTuiOptions;
  #block: StepBlock | undefined;
  /** Whether the current reply's step block is still open for this reply. */
  #blockOpen = false;
  #thought: ThoughtBlock | undefined;
  /** The line that says the turn is under way before there is anything to fold. */
  #pending: Text | undefined;
  #pendingStartedAt = 0;
  #inputHandler: ((text: string) => void) | undefined;
  #done: (() => void) | undefined;
  #stopped = false;
  #quitHint: string | undefined;
  #quitTimer: NodeJS.Timeout | undefined;
  #spinnerTimer: NodeJS.Timeout | undefined;
  #spinnerFrame = 0;
  /** Whether the near-limit note has been written for this turn. */
  #nearLimitReported = false;
  /** What the latest model call cost. Outlives the turn: it is the context line. */
  #usage: LlmUsage | undefined;
  /** The directory and the branch, read again once a second - not once a frame. */
  #cachedLocation: Location | undefined;
  #locationReadAt = 0;

  constructor(options: PiTuiOptions) {
    this.#options = options;
    this.#tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, {
      // The wheel has to reach the app as a mouse event: without mouse
      // capture the terminal turns it into cursor keys, which the editor
      // happily interprets as "walk through my input history" instead of
      // "scroll the transcript".
      mouse: options.mouse ?? true,
      scrollToEndIndicator: () => dim(' ↓ jump to latest '),
    });
    this.#document = new Container();
    this.#bar = {
      // Composed at render time, so a resized terminal gets a bar that fits
      // it, not a bar that fit what the terminal used to be.
      render: (width: number) => [this.#renderBar(width)],
      invalidate: () => undefined,
    };
    this.#editor = new Editor(this.#tui, editorTheme);
    this.#editor.onSubmit = (text: string) => this.#submit(text);

    this.#document.addChild(new Text(dim('replagent · the only language here is javascript')));
    this.#document.addChild(new Text(''));

    const transcript = new ScrollView(this.#document, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'auto',
    });

    // The bar is the last thing on the screen: it is the session's standing
    // line, and a standing line belongs at the foot of the page.
    const dock = new VStack([
      { component: this.#editor, shrink: 1, minSize: 3 },
      { component: this.#bar, shrink: 1, minSize: 1 },
    ]);

    const root = new VStack([
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
    ]);

    this.#tui.setLayoutRoot(root);
    this.#tui.setFocus(this.#editor);

    // ctrl+c never reaches the editor: the first press interrupts the turn,
    // the second one leaves.
    this.#tui.addInputListener((data) => {
      if (!matchesKey(data, 'ctrl+c')) {
        return undefined;
      }
      this.#handleInterrupt();
      return { consume: true };
    });

    // ctrl+e folds the code of the last step open and shut again.
    this.#tui.addInputListener((data) => {
      if (!matchesKey(data, 'ctrl+e')) {
        return undefined;
      }
      this.#toggleLatestStep();
      return { consume: true };
    });

    // ctrl+o does the same for the reasoning that came before it. Reading
    // the thinking and reading the code are different things, so they are
    // different keys.
    this.#tui.addInputListener((data) => {
      if (!matchesKey(data, 'ctrl+o')) {
        return undefined;
      }
      this.#toggleLatestThought();
      return { consume: true };
    });
  }

  emit(event: UiEvent): void {
    if (event.type === 'agent-thinking-delta') {
      this.#thinkingDelta(event.chars);
    } else if (event.type === 'agent-thinking') {
      this.#completeThinking(event.text);
    } else if (event.type === 'agent-code-delta') {
      this.#codeStarted();
    } else if (event.type === 'agent-code') {
      this.#completeStreaming(event.text);
    } else if (event.type === 'step') {
      this.#labelStep(event.name, event.description);
    } else if (event.type === 'exec-done') {
      this.#execDone();
    } else if (event.type === 'busy') {
      this.#applyBusy(event.busy);
    } else if (event.type === 'turn-progress') {
      this.#applyProgress(event.steps, event.maxSteps);
    } else if (event.type === 'turn-usage') {
      // What the conversation weighs now. It outlives the turn, because
      // that is what the next turn will carry.
      this.#usage = event.usage;
    } else {
      this.#appendBlock(event);
    }
    this.#tui.requestRender();
  }

  onInput(handler: (text: string) => void): void {
    this.#inputHandler = handler;
  }

  /** How far the transcript is scrolled away from its end. 0 means "at the end". */
  get transcriptScrollTop(): number {
    return this.#tui.viewportTop;
  }

  /**
   * The transcript as it stands, in the order it happened.
   *
   * The terminal shows a window on it and the window moves; this is the
   * whole thing, which is what the order of the transcript is about.
   */
  get transcriptText(): string {
    return this.#document.render(this.#tui.terminal.columns).join('\n');
  }

  /** True when the transcript is pinned to the newest output. */
  get isFollowingOutput(): boolean {
    return this.#tui.isFollowingOutput;
  }

  /** The status bar as it stands, composed for the current terminal width. */
  get statusBarText(): string {
    return this.#renderBar(this.#tui.terminal.columns);
  }

  async run(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#tui.start();
    await new Promise<void>((resolve) => {
      this.#done = resolve;
    });
    // The alternate screen is not where the scrollback lives, and the
    // transcript is worth keeping: leave the alternate screen without
    // repainting it, and put the whole transcript on the normal screen.
    this.#tui.stop({ preserveScreen: true });
    this.#leaveTranscriptBehind();
  }

  /**
   * Leave the transcript on the screen.
   *
   * The TUI draws on the alternate screen, and the alternate screen goes
   * away when it does - so without this the human is left with an empty
   * terminal and no record of what the agent did. Printing the transcript
   * puts it in the scrollback, where it stays.
   */
  #leaveTranscriptBehind(): void {
    const text = this.#document.render(this.#tui.terminal.columns).join('\n');
    this.#tui.terminal.write(`${text}\n`);
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    const done = this.#done;
    this.#done = undefined;
    done?.();
  }

  #submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (trimmed === '/quit' || trimmed === '/exit') {
      this.stop();
      return;
    }
    this.#editor.addToHistory(trimmed);
    this.#inputHandler?.(trimmed);
  }

  /**
   * First ctrl+c interrupts the running turn, second one quits. Two presses
   * within two seconds, so a stray ctrl+c never kills the session.
   *
   * The warning takes the bar for as long as it is true: it is about the
   * session, which is exactly what the bar is for.
   */
  #handleInterrupt(): void {
    if (this.#quitHint !== undefined) {
      this.stop();
      return;
    }

    this.#quitHint = 'press ctrl+c again to quit';
    this.#quitTimer = setTimeout(() => {
      this.#quitTimer = undefined;
      this.#quitHint = undefined;
      this.#tui.requestRender();
    }, QUIT_CONFIRM_MS);
    this.#quitTimer.unref();

    this.#options.onInterrupt?.();
    this.#tui.requestRender();
  }

  /**
   * Everything that is not part of the turn's own clock: the human, the
   * REPL's answers, the final line, and the notes about the run.
   */
  #appendBlock(
    event: Exclude<
      UiEvent,
      | { type: 'agent-code-delta' }
      | { type: 'agent-code' }
      | { type: 'agent-thinking-delta' }
      | { type: 'agent-thinking' }
      | { type: 'exec-done' }
      | { type: 'step' }
      | { type: 'busy' }
      | { type: 'turn-progress' }
      | { type: 'turn-usage' }
    >,
  ): void {
    switch (event.type) {
      case 'user-message':
        this.#document.addChild(new Text(`\n${bold(cyan('you'))} ${event.text}`));
        return;
      case 'repl-log':
        this.#addToStep(new Text(`${dim('  log')} ${event.text}`));
        return;
      case 'repl-value':
        this.#addToStep(new Text(`${dim('  =>  ')} ${green(event.text)}`));
        return;
      case 'repl-error':
        this.#addToStep(new Text(`${red('  error')} ${event.text}`));
        this.#markFailed();
        return;
      case 'final':
        this.#document.addChild(new Text(`\n${event.text}`));
        return;
      case 'status':
        // A note is a receipt: it happened, and it stays in the transcript
        // after the turn that produced it is over.
        this.#note(event.text);
        return;
    }
  }

  #note(text: string): void {
    this.#document.addChild(new Text(`${dim('  note')} ${dim(text)}`));
  }

  /**
   * Put what the step produced inside the step.
   *
   * The logs, the value and the error belong to the step that produced
   * them, so they open and close with it.
   */
  #addToStep(text: Text): void {
    const block = this.#block;
    if (block === undefined) {
      this.#document.addChild(text);
      return;
    }
    block.details.push(text);
    if (block.expanded) {
      block.group.addChild(text);
    }
  }

  #applyProgress(steps: number, maxSteps: number): void {
    if (this.#nearLimitReported || maxSteps <= 0 || steps / maxSteps < NEAR_LIMIT) {
      return;
    }
    // Said once, when the budget starts to run out, and then left alone:
    // a warning repeated every step is a warning nobody reads.
    this.#nearLimitReported = true;
    this.#note(`${steps} of ${maxSteps} steps used.`);
  }

  #applyBusy(busy: boolean): void {
    if (busy) {
      // A new turn starts. The folds of the last one stay where they are,
      // but they are nobody's newest step any more, and the work of this
      // turn has its own line.
      this.#relabel(this.#block, false);
      this.#block = undefined;
      this.#blockOpen = false;
      this.#relabelThought(false);
      this.#thought = undefined;
      this.#nearLimitReported = false;
      this.#openPending();
    } else {
      // The turn is over. Work that never got far enough to say anything
      // leaves nothing behind; work that produced something settles where
      // it stands, so the transcript still says what was run.
      this.#clearPending();
      this.#discardLiveThought();
      this.#settleLiveStep();
    }
    this.#setBusy(busy);
  }

  #openPending(): void {
    if (this.#pending !== undefined) {
      return;
    }
    const line = new Text('');
    this.#pending = line;
    this.#pendingStartedAt = Date.now();
    this.#document.addChild(line);
    this.#tickLive();
  }

  #clearPending(): void {
    const line = this.#pending;
    if (line === undefined) {
      return;
    }
    this.#document.removeChild(line);
    this.#pending = undefined;
  }

  /** The model is reasoning. Its fold starts here, alive, and counts as it grows. */
  #thinkingDelta(chars: number): void {
    this.#clearPending();
    if (this.#thought === undefined || !this.#thought.live) {
      this.#relabelThought(false);
      this.#openThought();
    }
    const block = this.#thought;
    if (block === undefined) {
      return;
    }
    block.chars = chars;
    this.#relabelThought(true);
  }

  #openThought(): ThoughtBlock {
    const header = new Text('');
    const group = new Container();
    group.addChild(header);

    const block: ThoughtBlock = {
      header,
      body: undefined,
      group,
      expanded: false,
      live: true,
      startedAt: Date.now(),
      chars: 0,
      elapsed: undefined,
    };

    this.#document.addChild(group);
    this.#thought = block;
    return block;
  }

  /**
   * The reasoning arrived, complete.
   *
   * The line that was counting settles on the same row and states what the
   * thought cost. The words are on ctrl+o.
   */
  #completeThinking(text: string): void {
    this.#clearPending();
    const existing = this.#thought;
    const block = existing?.live === true ? existing : this.#openThinkingOnArrival(text);
    block.live = false;
    block.chars = text.length;
    block.elapsed = Date.now() - block.startedAt;
    block.body = new Text(thinkingBody(text));
    if (block.expanded) {
      block.group.addChild(block.body);
    }
    this.#relabelThought(true);
  }

  /** The full reasoning arrived without deltas: the fold still happened. */
  #openThinkingOnArrival(text: string): ThoughtBlock {
    this.#relabelThought(false);
    const block = this.#openThought();
    block.chars = text.length;
    return block;
  }

  #discardLiveThought(): void {
    const block = this.#thought;
    if (block === undefined || !block.live) {
      return;
    }
    // It never finished, so there is no reasoning to show: a receipt for
    // words nobody can read is not worth the row.
    this.#document.removeChild(block.group);
    this.#thought = undefined;
  }

  /** The first chunk of code: the step's line replaces "replying". */
  #codeStarted(): void {
    this.#clearPending();
    if (this.#block !== undefined && this.#blockOpen) {
      return;
    }
    this.#relabel(this.#block, false);
    this.#openStepBlock('writing');
  }

  #openStepBlock(phase: 'writing' | 'running'): StepBlock {
    const header = new Text('');
    const group = new Container();
    group.addChild(header);

    const block: StepBlock = {
      header,
      code: undefined,
      group,
      details: [],
      label: undefined,
      phase,
      expanded: false,
      failed: false,
      live: true,
      startedAt: Date.now(),
      elapsed: undefined,
    };

    this.#document.addChild(group);
    this.#block = block;
    this.#blockOpen = true;
    this.#relabel(block, true);
    return block;
  }

  /**
   * The reply is complete and about to run. The line stops saying
   * "writing" and starts saying what the step is - or that it is running,
   * until the code names itself.
   */
  #completeStreaming(code: string): void {
    this.#clearPending();
    let block = this.#block;
    if (block === undefined || !this.#blockOpen) {
      this.#relabel(block, false);
      block = this.#openStepBlock('running');
    }
    block.phase = 'running';
    block.code = new Text(this.#renderCodeBody(this.#colour(this.#format(code))));
    if (block.expanded) {
      block.group.addChild(block.code);
    }
    this.#relabel(block, true);
  }

  /** The code finished running: the line settles, with the time it took. */
  #execDone(): void {
    const block = this.#block;
    if (block === undefined) {
      return;
    }
    this.#settle(block);
    this.#blockOpen = false;
    this.#relabel(block, true);
  }

  #settleLiveStep(): void {
    const block = this.#block;
    if (block === undefined || !block.live) {
      return;
    }
    if (block.code === undefined) {
      // Interrupted before the reply was complete: there is no code to
      // open, so there is no fold to leave behind.
      this.#document.removeChild(block.group);
      this.#block = undefined;
      this.#blockOpen = false;
      return;
    }
    this.#settle(block);
    this.#blockOpen = false;
    this.#relabel(block, true);
  }

  #settle(block: StepBlock): void {
    if (!block.live) {
      return;
    }
    block.live = false;
    block.elapsed = Date.now() - block.startedAt;
  }

  #toggleThought(block: ThoughtBlock): void {
    const body = block.body;
    if (body === undefined) {
      return;
    }
    block.expanded = !block.expanded;
    if (block.expanded) {
      block.group.addChild(body);
    } else {
      block.group.removeChild(body);
    }
    this.#relabelThought(true);
    this.#tui.requestRender();
  }

  #toggleLatestThought(): void {
    const block = this.#thought;
    if (block !== undefined) {
      this.#toggleThought(block);
    }
  }

  /** The thought's header: alive while it grows, then what it cost. */
  #thoughtLabel(block: ThoughtBlock, latest: boolean): string {
    const marker = block.live ? cyan(this.#spinner()) : dim('●');
    const seconds = block.live
      ? Date.now() - block.startedAt
      : block.elapsed === undefined
        ? undefined
        : block.elapsed;
    const cost = [`${formatTokens(block.chars)} chars`];
    if (seconds !== undefined) {
      cost.push(formatSeconds(seconds));
    }
    const title = `${marker} ${dim(`Thought ${cost.join(' · ')}`)}`;
    if (!latest || block.live) {
      return title;
    }
    const hint = block.expanded ? 'ctrl+o closes the thinking' : 'ctrl+o opens the thinking';
    return `${title}   ${dim(`· ${hint}`)}`;
  }

  #relabelThought(latest: boolean): void {
    const block = this.#thought;
    if (block !== undefined) {
      block.header.setText(this.#thoughtLabel(block, latest));
    }
  }

  /**
   * Open the step, or close it again.
   *
   * What opens is everything the step produced: the code it wrote, the
   * lines it logged, the value it returned. What the human reads without
   * opening anything is the step itself.
   */
  #toggleStep(block: StepBlock): void {
    block.expanded = !block.expanded;

    if (block.expanded) {
      if (block.code !== undefined) {
        block.group.addChild(block.code);
      }
      for (const detail of block.details) {
        block.group.addChild(detail);
      }
    } else {
      if (block.code !== undefined) {
        block.group.removeChild(block.code);
      }
      for (const detail of block.details) {
        block.group.removeChild(detail);
      }
    }

    this.#relabel(block, true);
    this.#tui.requestRender();
  }

  /**
   * Show or hide the step that ran last.
   *
   * The transcript keeps the steps folded away, and the title is what the
   * human reads. When the step itself is what is wanted, this is the way
   * to get at it.
   */
  #toggleLatestStep(): void {
    const block = this.#block;
    if (block !== undefined) {
      this.#toggleStep(block);
    }
  }

  /** What the step is doing, or what it did. */
  #stepName(block: StepBlock): string {
    if (block.label !== undefined) {
      return block.label;
    }
    if (!block.live) {
      return 'js';
    }
    return block.phase === 'writing' ? 'writing' : 'running';
  }

  #blockLabel(block: StepBlock, latest: boolean): string {
    const marker = block.live ? cyan(this.#spinner()) : dim('●');
    const seconds = block.live
      ? Date.now() - block.startedAt
      : block.elapsed === undefined
        ? undefined
        : block.elapsed;
    const title = `${marker} ${dim(this.#stepName(block))}${
      seconds === undefined ? '' : dim(` · ${formatSeconds(seconds)}`)
    }`;
    // A step that failed says so, even folded away: a transcript that
    // hides the failure is a transcript that lies by omission.
    const body = block.failed ? red(title) : title;
    if (!latest || block.live) {
      return body;
    }
    // The affordance lives at the tail of the fold, on the newest step:
    // the hint belongs where the fold is, not down on the status line.
    const hint = block.expanded ? 'ctrl+e closes the step' : 'ctrl+e opens the step';
    return `${body}   ${dim(`· ${hint}`)}`;
  }

  /** Set a step's header to its label for the state it is in now. */
  #relabel(block: StepBlock | undefined, latest: boolean): void {
    if (block !== undefined) {
      block.header.setText(this.#blockLabel(block, latest));
    }
  }

  /** The last step did not work, and the transcript should not hide it. */
  #markFailed(): void {
    const block = this.#block;
    if (block === undefined) {
      return;
    }
    block.failed = true;
    this.#settle(block);
    // Rejected code never runs, so no exec-done will close this block:
    // without this the next reply would write into it.
    this.#blockOpen = false;
    this.#relabel(block, true);
  }

  /**
   * Put the step's name and description on the step.
   *
   * The step names itself before its body runs, so this arrives while the
   * line is still alive - which is the point: the human sees what the
   * agent is doing, not what it did.
   */
  #labelStep(name: string, description: string): void {
    const block = this.#block;
    if (block === undefined) {
      return;
    }
    block.label = `${name} - ${description}`;
    this.#relabel(block, true);
  }

  #renderCodeBody(source: string): string {
    return source
      .split('\n')
      .map((line) => `${dim('│')} ${line}`)
      .join('\n');
  }

  #format(code: string): string {
    const formatter = this.#options.formatter;
    if (formatter === undefined) {
      return code;
    }
    return formatter.format(code);
  }

  /**
   * The colours go on after the formatting, so they land on the columns
   * the human is reading.
   */
  #colour(code: string): string {
    const highlighter = this.#options.highlighter;
    if (highlighter === undefined) {
      return code;
    }
    return highlighter.highlight(code);
  }

  #spinner(): string {
    return SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length] ?? '';
  }

  #pendingLabel(now: number): string {
    return `${cyan(this.#spinner())} ${dim(`replying · ${formatSeconds(now - this.#pendingStartedAt)}`)}`;
  }

  /**
   * Move the clock on every line that is alive.
   *
   * Only the work moves. The bar is a statement about the session, and a
   * statement does not tick.
   */
  #tickLive(): void {
    const now = Date.now();
    if (this.#pending !== undefined) {
      this.#pending.setText(this.#pendingLabel(now));
    }
    const thought = this.#thought;
    if (thought?.live === true) {
      thought.header.setText(this.#thoughtLabel(thought, true));
    }
    const block = this.#block;
    if (block?.live === true) {
      block.header.setText(this.#blockLabel(block, true));
    }
  }

  /**
   * The spinner answers "did my message even go out?": the line of the
   * work that is running spins, and it settles when the work is done.
   */
  #setBusy(busy: boolean): void {
    if (busy) {
      if (this.#spinnerTimer === undefined) {
        this.#spinnerTimer = setInterval(() => {
          this.#spinnerFrame += 1;
          this.#tickLive();
          this.#tui.requestRender();
        }, SPINNER_INTERVAL_MS);
        this.#spinnerTimer.unref();
      }
    } else if (this.#spinnerTimer !== undefined) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = undefined;
    }
    this.#tickLive();
  }

  #location(): Location {
    const now = Date.now();
    if (this.#cachedLocation !== undefined && now - this.#locationReadAt < LOCATION_REFRESH_MS) {
      return this.#cachedLocation;
    }
    const location = (this.#options.location ?? defaultLocation)();
    this.#cachedLocation = location;
    this.#locationReadAt = now;
    return location;
  }

  /**
   * The status bar.
   *
   * On the left, where the session is and who it talks to. On the right,
   * what the conversation weighs - the only numbers that outlive a turn.
   * None of it moves while the agent works: liveness is on the step.
   */
  #renderBar(width: number): string {
    const variants = this.#barIdentityVariants().map((variant) => dim(variant));
    const items = this.#barItems();

    // The numbers are what the bar exists for, so they leave last: first
    // the cache rate, then the context weight, and only then the identity
    // starts shortening.
    for (let count = items.length; count >= 0; count -= 1) {
      const right = items.slice(0, count).join(BAR_SEPARATOR);
      const gap = count > 0 ? MIN_GAP : 0;
      const room = width - visibleWidth(right) - gap;
      const left = variants.find((variant) => visibleWidth(variant) <= room);
      if (left !== undefined) {
        const slack = width - visibleWidth(left) - visibleWidth(right);
        return `${left}${' '.repeat(slack)}${right}`;
      }
    }

    return truncateToWidth(variants[variants.length - 1] ?? '', width);
  }

  /**
   * The left half, longest first. The path gives up its leading segments,
   * then the endpoint and the model leave - the directory and the branch
   * are where you are, and that is the last thing to go.
   */
  #barIdentityVariants(): string[] {
    const location = this.#location();
    const branch = location.branch === undefined ? undefined : `⎇ ${location.branch}`;
    const model = this.#options.model;
    const endpoint = this.#endpointSegment();
    const variant = (
      where: string,
      keepBranch: boolean,
      keepModel: boolean,
      keepEndpoint: boolean,
    ): string =>
      [
        where,
        keepBranch ? branch : undefined,
        keepModel ? model : undefined,
        keepEndpoint ? endpoint : undefined,
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(' · ');

    return [
      variant(location.path, true, true, true),
      variant(elidePath(location.path, 2), true, true, true),
      variant(elidePath(location.path, 1), true, true, true),
      variant(elidePath(location.path, 1), true, true, false),
      variant(elidePath(location.path, 1), true, false, false),
      variant(elidePath(location.path, 1), false, false, false),
    ];
  }

  #endpointSegment(): string | undefined {
    const endpoint = this.#options.endpoint;
    if (endpoint === undefined || endpoint.length === 0 || endpoint === DEFAULT_ENDPOINT) {
      return undefined;
    }
    return endpoint;
  }

  /**
   * The right side of the bar: what the conversation weighs, and how much
   * of it the cache served. Nothing about the turn belongs here - it is
   * over almost as soon as you read it.
   */
  #barItems(): string[] {
    if (this.#quitHint !== undefined) {
      return [yellow(this.#quitHint)];
    }
    const usage = this.#usage;
    if (usage === undefined) {
      return [];
    }
    const items = [this.#contextItem(usage)];
    const rate = cacheRate(usage);
    if (rate !== undefined) {
      items.push(dim(`${rate}% cached`));
    }
    return items;
  }

  /** The prompt against the window it fits in - `45.2k/200k` - when known. */
  #contextItem(usage: LlmUsage): string {
    const used = formatTokens(usage.input);
    const window = this.#options.contextWindow;
    if (window === undefined) {
      return dim(`${used} ctx`);
    }
    const text = `${used}/${formatTokens(window)}`;
    return usage.input / window >= NEAR_CONTEXT ? yellow(text) : dim(text);
  }

  #clearTimers(): void {
    if (this.#spinnerTimer !== undefined) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = undefined;
    }
    if (this.#quitTimer !== undefined) {
      clearTimeout(this.#quitTimer);
      this.#quitTimer = undefined;
    }
  }
}
