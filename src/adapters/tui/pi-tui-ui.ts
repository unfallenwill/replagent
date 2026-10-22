import {
  Container,
  Editor,
  type EditorTheme,
  ProcessTerminal,
  ScrollView,
  type SelectListTheme,
  type Terminal,
  Text,
  TuiAltScreen,
  VStack,
} from '@earendil-works/pi-tui';
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

export interface PiTuiOptions {
  readonly model: string;
  /** Terminal to render on. Defaults to the process terminal. */
  readonly terminal?: Terminal;
  /** Host the agent talks to, shown in the header. */
  readonly endpoint?: string;
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
  #streaming: Text | undefined;
  #streamingText = '';
  #inputHandler: ((text: string) => void) | undefined;
  #done: (() => void) | undefined;
  #stopped = false;
  #busy = false;
  #spinnerTimer: NodeJS.Timeout | undefined;
  #spinnerFrame = 0;

  constructor(options: PiTuiOptions) {
    this.#tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, {
      mouse: false,
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
  }

  emit(event: UiEvent): void {
    if (event.type === 'agent-code-delta') {
      this.#appendStreaming(event.text);
    } else if (event.type === 'agent-code') {
      this.#completeStreaming(event.text);
    } else if (event.type === 'busy') {
      this.#setBusy(event.busy);
    } else {
      this.#appendBlock(event);
    }
    this.#tui.requestRender();
  }

  onInput(handler: (text: string) => void): void {
    this.#inputHandler = handler;
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
    this.#stopSpinner();
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
        this.#status.setText(dim(event.text));
        return;
    }
  }

  #appendStreaming(delta: string): void {
    this.#streamingText += delta;
    this.#ensureStreaming().setText(this.#renderCode(this.#streamingText));
  }

  #completeStreaming(code: string): void {
    this.#streamingText = code;
    this.#ensureStreaming().setText(this.#renderCode(code));
  }

  #ensureStreaming(): Text {
    if (this.#streaming === undefined) {
      this.#streaming = new Text('');
      this.#document.addChild(this.#streaming);
    }
    this.#streaming.invalidate();
    return this.#streaming;
  }

  #renderCode(code: string): string {
    const body = code
      .split('\n')
      .map((line) => `${dim('│')} ${line}`)
      .join('\n');
    return `\n${dim('js')}\n${body}`;
  }

  /**
   * The busy indicator is the answer to "did my message even go out?": as
   * soon as the agent starts working, the status line shows a spinner, and it
   * stops when the turn is over.
   */
  #setBusy(busy: boolean): void {
    this.#busy = busy;
    if (!busy) {
      this.#stopSpinner();
      this.#status.setText('');
      return;
    }
    if (this.#spinnerTimer !== undefined) {
      return;
    }
    this.#spinnerTimer = setInterval(() => {
      const frame = SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length] ?? '';
      this.#spinnerFrame += 1;
      this.#status.setText(`${cyan(frame)} ${dim('working…')}`);
      this.#tui.requestRender();
    }, SPINNER_INTERVAL_MS);
    this.#spinnerTimer.unref();
  }

  #stopSpinner(): void {
    if (this.#spinnerTimer !== undefined) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = undefined;
    }
    if (this.#busy) {
      this.#busy = false;
      this.#status.setText('');
    }
  }
}
