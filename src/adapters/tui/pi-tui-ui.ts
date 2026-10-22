import {
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
  VStack,
} from '@earendil-works/pi-tui';
import type { CodeFormatter, CodeHighlighter } from '../../domain/ports/format.js';
import type { UiEvent, UiPort } from '../../domain/ports/ui.js';
import { bold, cyan, dim, green, red } from '../format/ansi.js';

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
 * A block of code the agent wrote.
 *
 * The code is folded away: what the human sees is the step - its name and
 * what it was for - because that is what the transcript is for. The code is
 * one keystroke away for the times when the human wants to see it.
 */
interface CodeBlock {
  readonly header: Text;
  readonly body: Text;
  label: string;
  expanded: boolean;
}

export class PiTuiUi implements UiPort {
  readonly #tui: TuiAltScreen;
  readonly #document: Container;
  readonly #editor: Editor;
  readonly #status: Text;
  readonly #options: PiTuiOptions;
  #block: CodeBlock | undefined;
  #inputHandler: ((text: string) => void) | undefined;
  #done: (() => void) | undefined;
  #stopped = false;
  #busy = false;
  #statusText: string | undefined;
  #quitHint: string | undefined;
  #quitTimer: NodeJS.Timeout | undefined;
  #spinnerTimer: NodeJS.Timeout | undefined;
  #spinnerFrame = 0;

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
    this.#editor = new Editor(this.#tui, editorTheme);
    this.#editor.onSubmit = (text: string) => this.#submit(text);

    const header = ['replagent', options.model, options.endpoint ?? '']
      .filter((part) => part.length > 0)
      .join(' · ');
    this.#document.addChild(new Text(dim(`${header} · the only language here is javascript`)));
    this.#document.addChild(new Text(''));

    const transcript = new ScrollView(this.#document, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'auto',
    });

    const dock = new VStack([
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
      this.#toggleLatestCode();
      return { consume: true };
    });
  }

  emit(event: UiEvent): void {
    if (event.type === 'agent-code-delta') {
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
        this.#block = undefined;
      }
      this.#setBusy(event.busy);
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

  async run(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#tui.start();
    await new Promise<void>((resolve) => {
      this.#done = resolve;
    });
    this.#tui.stop();
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
        this.#document.addChild(new Text(`${dim('  log')} ${event.text}`));
        return;
      case 'repl-value':
        this.#document.addChild(new Text(`${dim('  =>  ')} ${green(event.text)}`));
        return;
      case 'repl-error':
        this.#document.addChild(new Text(`${red('  error')} ${event.text}`));
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

  #appendStreaming(_delta: string): void {
    // The code is folded away, so there is nothing to show while it is
    // being written: the step it turns out to be says more than the code.
  }

  #completeStreaming(code: string): void {
    const header = new Text('');
    const body = new Text(this.#renderCodeBody(this.#colour(this.#format(code))));
    const block: CodeBlock = {
      header,
      body,
      label: 'js',
      expanded: false,
    };

    this.#document.addChild(header);
    this.#block = block;
    header.setText(this.#blockLabel(block));
  }

  /**
   * Show the code of the block, or hide it again.
   */
  #toggleCode(block: CodeBlock): void {
    block.expanded = !block.expanded;
    if (block.expanded) {
      this.#insertAfter(block.header, block.body);
    } else {
      this.#document.removeChild(block.body);
    }
    block.header.setText(this.#blockLabel(block));
    this.#tui.requestRender();
  }

  /**
   * Put the code right below the step it belongs to.
   *
   * The step's place in the transcript was taken when it was written, so
   * the code belongs there - between the step and whatever the agent said
   * after it - and not at the end of the document.
   */
  #insertAfter(anchor: Text, component: Text): void {
    const index = this.#document.children.indexOf(anchor);
    if (index === -1) {
      this.#document.addChild(component);
      return;
    }
    this.#document.children.splice(index + 1, 0, component);
  }

  /**
   * Show or hide the code of the step that ran last.
   *
   * The transcript keeps the code folded away, and the step is what the
   * human reads. When the code itself is what is wanted, this is the way
   * to get at it.
   */
  #toggleLatestCode(): void {
    const block = this.#block;
    if (block === undefined) {
      return;
    }
    this.#toggleCode(block);
  }

  #blockLabel(block: CodeBlock): string {
    const marker = block.expanded ? cyan('▼') : dim('▶');
    return `${marker} ${block.label}`;
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
    block.header.setText(this.#blockLabel(block));
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
   * The busy indicator is the answer to "did my message even go out?": as
   * soon as the agent starts working, the status line shows a spinner, and it
   * stops when the turn is over.
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
    if (this.#busy) {
      const frame = SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length] ?? '';
      parts.push(`${cyan(frame)} ${dim('working…')}`);
    }
    if (this.#quitHint !== undefined) {
      parts.push(dim(this.#quitHint));
    }
    if (this.#statusText !== undefined && this.#statusText.length > 0) {
      parts.push(dim(this.#statusText));
    }
    if (this.#block !== undefined && !this.#block.expanded) {
      parts.push(dim('ctrl+e shows the code'));
    }
    this.#status.setText(parts.join('   '));
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
