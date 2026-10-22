import {
  Container,
  Editor,
  type EditorTheme,
  ProcessTerminal,
  ScrollView,
  type SelectListTheme,
  type Terminal,
  Text,
  TuiMainScreen,
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

export interface PiTuiOptions {
  readonly model: string;
  /** Terminal to render on. Defaults to the process terminal. */
  readonly terminal?: Terminal;
}

/**
 * The window into the agent.
 *
 * Everything the agent does shows up here: the JavaScript it writes, what the
 * REPL logged, what the last expression evaluated to, and the errors it has
 * to work through. The human types at the bottom.
 */
export class PiTuiUi implements UiPort {
  readonly #tui: TuiMainScreen;
  readonly #document: Container;
  readonly #editor: Editor;
  readonly #status: Text;
  #streaming: Text | undefined;
  #streamingText = '';
  #inputHandler: ((text: string) => void) | undefined;
  #done: (() => void) | undefined;
  #stopped = false;

  constructor(options: PiTuiOptions) {
    this.#tui = new TuiMainScreen(options.terminal ?? new ProcessTerminal());
    this.#document = new Container();
    this.#status = new Text('');
    this.#editor = new Editor(this.#tui, editorTheme);
    this.#editor.onSubmit = (text: string) => this.#submit(text);

    this.#document.addChild(
      new Text(dim(`replagent · ${options.model} · the only language here is javascript`)),
    );
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

    this.#tui.addChild(root);
    this.#tui.setFocus(this.#editor);
  }

  emit(event: UiEvent): void {
    if (event.type === 'agent-code-delta') {
      this.#appendStreaming(event.text);
    } else if (event.type === 'agent-code') {
      this.#completeStreaming(event.text);
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

  #appendBlock(event: Exclude<UiEvent, { type: 'agent-code-delta' | 'agent-code' }>): void {
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
    if (this.#streaming === undefined) {
      this.#streaming = new Text('');
      this.#document.addChild(this.#streaming);
    }
    this.#streaming.setText(this.#renderCode(this.#streamingText));
    this.#streaming.invalidate();
  }

  #completeStreaming(code: string): void {
    this.#streamingText = code;
    if (this.#streaming === undefined) {
      this.#streaming = new Text('');
      this.#document.addChild(this.#streaming);
    }
    this.#streaming.setText(this.#renderCode(code));
    this.#streaming.invalidate();
  }

  #renderCode(code: string): string {
    const body = code
      .split('\n')
      .map((line) => `${dim('│')} ${line}`)
      .join('\n');
    return `\n${dim('js')}\n${body}`;
  }
}
