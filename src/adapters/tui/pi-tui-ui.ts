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
 * How much of the step budget may be spent before the counter changes
 * colour. The number itself is the report; the colour only says that the
 * end of the budget is close.
 */
const NEAR_LIMIT = 0.85;

/** Between the two halves of the status bar. */
const BAR_SEPARATOR = dim(' · ');
/** The narrowest the identity may be truncated to before it gives way entirely. */
const MIN_IDENTITY = 8;
/** The smallest gap the two halves of the bar may keep between them. */
const MIN_GAP = 2;

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

/** How long the current turn has been running: `42s`, then `3m07s`. */
function formatElapsed(startedAt: number | undefined): string {
  if (startedAt === undefined) {
    return '';
  }
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export interface PiTuiOptions {
  readonly model: string;
  /** Terminal to render on. Defaults to the process terminal. */
  readonly terminal?: Terminal;
  /** Host the agent talks to, shown in the header. */
  readonly endpoint?: string;
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
 */
/**
 * A step in the transcript.
 *
 * The human sees the title: the name the agent gave the step and what it
 * was for. Everything the step produced - the code, the logs, the value -
 * belongs to it, and opens and closes with it. One keystroke away, and
 * not in the way.
 */
interface StepBlock {
  readonly header: Text;
  readonly code: Text;
  readonly group: Container;
  readonly details: Text[];
  label: string;
  expanded: boolean;
  failed: boolean;
}

export class PiTuiUi implements UiPort {
  readonly #tui: TuiAltScreen;
  readonly #document: Container;
  readonly #editor: Editor;
  /** The pinned line: who you are talking to, and what the turn costs. */
  readonly #bar: Component;
  readonly #status: Text;
  readonly #options: PiTuiOptions;
  #block: StepBlock | undefined;
  #inputHandler: ((text: string) => void) | undefined;
  #done: (() => void) | undefined;
  #stopped = false;
  #busy = false;
  #statusText: string | undefined;
  #quitHint: string | undefined;
  #quitTimer: NodeJS.Timeout | undefined;
  #spinnerTimer: NodeJS.Timeout | undefined;
  #spinnerFrame = 0;
  /** Steps done in the current turn, against the budget. */
  #turnSteps = 0;
  #maxSteps: number | undefined;
  /** What the latest model call cost. Outlives the turn: it is the context line. */
  #usage: LlmUsage | undefined;
  /** Output tokens spent by the current turn so far. */
  #turnOutput = 0;
  /** The step the agent is on right now - gone as soon as the next reply starts. */
  #currentStep: string | undefined;
  #turnStartedAt: number | undefined;

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
    this.#status = new Text('');
    this.#bar = {
      // Composed at render time, so a resized terminal gets a bar that fits
      // it, not a bar that fit what the terminal used to be.
      render: (width: number) => [this.#renderBar(width)],
      invalidate: () => undefined,
    };
    this.#editor = new Editor(this.#tui, editorTheme);
    this.#editor.onSubmit = (text: string) => this.#submit(text);

    // The model and the endpoint moved to the bar: they are only useful
    // while they are on the screen, and the transcript scrolls.
    this.#document.addChild(new Text(dim('replagent · the only language here is javascript')));
    this.#document.addChild(new Text(''));

    const transcript = new ScrollView(this.#document, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'auto',
    });

    const dock = new VStack([
      { component: this.#bar, shrink: 1, minSize: 1 },
      { component: this.#status, shrink: 1, minSize: 0 },
      { component: this.#editor, shrink: 1, minSize: 3 },
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
  }

  emit(event: UiEvent): void {
    if (event.type === 'agent-code-delta') {
      // A new reply is being written, and the step it belongs to has no name
      // yet: whatever the bar showed for the previous step is stale now.
      this.#currentStep = undefined;
      this.#appendStreaming(event.text);
    } else if (event.type === 'agent-code') {
      this.#completeStreaming(event.text);
    } else if (event.type === 'step') {
      this.#labelStep(event.name, event.description);
    } else if (event.type === 'busy') {
      if (event.busy) {
        // A new turn starts. The code block belongs to a turn, so the next
        // turn gets its own - and a step that arrives late must not label
        // the block of the turn that follows it.
        this.#relabel(this.#block, false);
        this.#block = undefined;
        this.#turnSteps = 0;
        this.#turnOutput = 0;
        this.#currentStep = undefined;
        this.#turnStartedAt = Date.now();
      } else {
        this.#turnStartedAt = undefined;
      }
      this.#setBusy(event.busy);
    } else if (event.type === 'turn-progress') {
      this.#turnSteps = event.steps;
      this.#maxSteps = event.maxSteps;
    } else if (event.type === 'turn-usage') {
      this.#usage = event.usage;
      this.#turnOutput += event.usage.output;
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
      this.#renderStatus();
    }, QUIT_CONFIRM_MS);
    this.#quitTimer.unref();

    this.#renderStatus();
    this.#options.onInterrupt?.();
    this.#tui.requestRender();
  }

  #appendBlock(
    event: Exclude<UiEvent, { type: 'agent-code-delta' | 'agent-code' | 'busy' }>,
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
        this.#statusText = event.text;
        this.#renderStatus();
        return;
    }
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

  #appendStreaming(_delta: string): void {
    // The step is folded away, so there is nothing to show while it is
    // being written: the title it turns out to be says more than the code.
  }

  #completeStreaming(code: string): void {
    // ctrl+e follows the newest step, so the previous step's header gives up
    // the hint first: a hint that points nowhere is worse than none.
    this.#relabel(this.#block, false);

    const header = new Text('');
    const group = new Container();
    group.addChild(header);

    const block: StepBlock = {
      header,
      code: new Text(this.#renderCodeBody(this.#colour(this.#format(code)))),
      group,
      details: [],
      label: 'js',
      expanded: false,
      failed: false,
    };

    this.#document.addChild(group);
    this.#block = block;
    this.#relabel(block, true);
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
      block.group.addChild(block.code);
      for (const detail of block.details) {
        block.group.addChild(detail);
      }
    } else {
      block.group.removeChild(block.code);
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
    if (block === undefined) {
      return;
    }
    this.#toggleStep(block);
  }

  #blockLabel(block: StepBlock, latest: boolean): string {
    const marker = block.expanded ? cyan('▼') : dim('▶');
    const title = `${marker} ${block.label}`;
    // A step that failed says so, even folded away: a transcript that
    // hides the failure is a transcript that lies by omission.
    const body = block.failed ? red(title) : title;
    if (!latest) {
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
    this.#relabel(block, true);
  }

  /**
   * Put the step's name and description on the code block.
   *
   * The block was created when the code arrived; the step comes after it,
   * because the agent only says what the step was once it has written it.
   */
  #labelStep(name: string, description: string): void {
    const block = this.#block;
    if (block === undefined) {
      return;
    }
    block.label = `${name} - ${description}`;
    // The name is also the bar's "what is it doing right now", so it stays
    // readable while the human is scrolled away from the newest step.
    this.#currentStep = name;
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

  /**
   * The spinner answers "did my message even go out?": as soon as the agent
   * starts working, the status bar spins, and it stops when the turn is
   * over. The bar reads the clock off the same tick, so the seconds move
   * with the frames.
   */
  #setBusy(busy: boolean): void {
    this.#busy = busy;
    if (busy) {
      if (this.#spinnerTimer === undefined) {
        this.#spinnerTimer = setInterval(() => {
          this.#spinnerFrame += 1;
          this.#renderStatus();
          this.#tui.requestRender();
        }, SPINNER_INTERVAL_MS);
        this.#spinnerTimer.unref();
      }
    } else if (this.#spinnerTimer !== undefined) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = undefined;
    }
    this.#renderStatus();
  }

  #renderStatus(): void {
    const parts: string[] = [];
    if (this.#quitHint !== undefined) {
      parts.push(dim(this.#quitHint));
    }
    if (this.#statusText !== undefined && this.#statusText.length > 0) {
      parts.push(dim(this.#statusText));
    }
    this.#status.setText(parts.join('   '));
  }

  /**
   * The status bar.
   *
   * On the left, who you are talking to. On the right, what the agent is
   * doing and what it costs - and when the agent is idle, only what the
   * conversation now weighs. Everything on it answers a question the human
   * actually has, and the narrow terminal takes the answers away in
   * ascending order of importance.
   */
  #renderBar(width: number): string {
    const left = dim(this.#barIdentity());
    return this.#fitBar(left, this.#barItems(), width);
  }

  #barIdentity(): string {
    return [this.#options.model, this.#options.endpoint ?? '']
      .filter((part) => part.length > 0)
      .join(' · ');
  }

  /**
   * The right side of the bar, most important first.
   *
   * While the agent works: the spinner and the step counter, the weight of
   * the conversation, the cache rate, the age of the turn, its output, and
   * the step it is on. When it rests: only what the last request carried.
   */
  #barItems(): string[] {
    const items: string[] = [];
    if (this.#busy) {
      items.push(this.#activity());
    }
    if (this.#usage !== undefined) {
      items.push(dim(`${formatTokens(this.#usage.input)} in`));
      const rate = cacheRate(this.#usage);
      if (rate !== undefined) {
        items.push(dim(`${rate}% cached`));
      }
    }
    if (this.#busy) {
      const elapsed = formatElapsed(this.#turnStartedAt);
      if (elapsed.length > 0) {
        items.push(dim(elapsed));
      }
      items.push(dim(`${formatTokens(this.#turnOutput)} out`));
    }
    if (this.#busy && this.#currentStep !== undefined) {
      items.push(dim(this.#currentStep));
    }
    return items;
  }

  /** The spinner and, once the budget is known, the step counter. */
  #activity(): string {
    const frame = SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length] ?? '';
    let text = cyan(frame);
    if (this.#maxSteps !== undefined) {
      const counter = `step ${this.#turnSteps}/${this.#maxSteps}`;
      text += ` ${this.#nearLimit() ? yellow(counter) : counter}`;
    }
    return text;
  }

  #nearLimit(): boolean {
    return this.#maxSteps !== undefined && this.#turnSteps / this.#maxSteps >= NEAR_LIMIT;
  }

  /**
   * Fit both halves on one line.
   *
   * The right side gives up its items from the far end - the step name,
   * then the output, the seconds, the cache rate, the token counts - until
   * what is left fits beside the identity. Then the identity shortens, and
   * only past that does the bar stop being two halves at all.
   */
  #fitBar(left: string, items: readonly string[], width: number): string {
    let shown = items;
    let right = shown.join(BAR_SEPARATOR);
    while (shown.length > 1 && visibleWidth(left) + visibleWidth(right) + MIN_GAP > width) {
      shown = shown.slice(0, -1);
      right = shown.join(BAR_SEPARATOR);
    }

    const slack = width - visibleWidth(left) - visibleWidth(right);
    if (slack >= MIN_GAP) {
      return `${left}${' '.repeat(slack)}${right}`;
    }

    const room = width - visibleWidth(right) - MIN_GAP;
    if (room >= MIN_IDENTITY) {
      return `${truncateToWidth(left, room)}${' '.repeat(MIN_GAP)}${right}`;
    }
    return truncateToWidth(right, width);
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
