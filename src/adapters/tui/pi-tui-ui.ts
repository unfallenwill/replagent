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
import type { CodeFormatter } from '../../domain/ports/format.js';
import type { UiEvent, UiPort } from '../../domain/ports/ui.js';

const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`;
const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`;
const red = (text: string): string => `\u001b[31m${text}\u001b[0m`;
const green = (text: string): string => `\u001b[32m${text}\u001b[0m`;
const cyan = (text: string): string => `\u001b[36m${text}\u001b[0m`;

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
export class PiTuiUi implements UiPort {
  readonly #tui: TuiAltScreen;
  readonly #document: Container;
  readonly #editor: Editor;
  readonly #status: Text;
  readonly #options: PiTuiOptions;
  #streaming: Text | undefined;
  #streamingText = '';
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
  }

  emit(event: UiEvent): void {
    if (event.type === 'agent-code-delta') {
      this.#appendStreaming(event.text);
    } else if (event.type === 'agent-code') {
      this.#completeStreaming(event.text);
    } else if (event.type === 'busy') {
      if (event.busy) {
        // A new turn starts. The code block belongs to a turn, so the next
        // turn gets its own - otherwise its code would overwrite the block of
        // the previous turn and appear above it instead of below.
        this.#releaseStreamingBlock();
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
        this.#document.addChild(new Text(`\n${bold('answer')} ${event.text}`));
        return;
      case 'status':
        this.#statusText = event.text;
        this.#renderStatus();
        return;
    }
  }

  #appendStreaming(delta: string): void {
    this.#streamingText += delta;
    // The streaming code is not formatted: it is not valid JavaScript yet,
    // and formatting on every token would be quadratic.
    this.#ensureStreaming().setText(this.#renderCode(this.#streamingText, false));
  }

  #completeStreaming(code: string): void {
    this.#streamingText = code;
    this.#ensureStreaming().setText(this.#renderCode(code, true));
    this.#releaseStreamingBlock();
  }

  #releaseStreamingBlock(): void {
    this.#streaming = undefined;
    this.#streamingText = '';
  }

  #ensureStreaming(): Text {
    if (this.#streaming === undefined) {
      this.#streaming = new Text('');
      this.#document.addChild(this.#streaming);
    }
    this.#streaming.invalidate();
    return this.#streaming;
  }

  #renderCode(code: string, formatted: boolean): string {
    const source = formatted ? this.#format(code) : code;
    const body = source
      .split('\n')
      .map((line) => `${dim('│')} ${line}`)
      .join('\n');
    return `\n${dim('js')}\n${body}`;
  }

  #format(code: string): string {
    const formatter = this.#options.formatter;
    if (formatter === undefined) {
      return code;
    }
    return formatter.format(code);
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
