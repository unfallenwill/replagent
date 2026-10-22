import beautify from 'js-beautify';
import type { CodeFormatter } from '../../domain/ports/format.js';

export interface JsBeautifyOptions {
  readonly indentSize?: number;
}

/**
 * Formats JavaScript for the transcript.
 *
 * Formatting is best effort: code that cannot be parsed is shown as it was
 * written, because the point of the transcript is to show what the agent
 * actually tried to run.
 */
export class JsBeautifyFormatter implements CodeFormatter {
  readonly #indentSize: number;

  constructor(options: JsBeautifyOptions = {}) {
    this.#indentSize = options.indentSize ?? 2;
  }

  format(code: string): string {
    try {
      return beautify.js(code, {
        indent_size: this.#indentSize,
        indent_char: ' ',
        max_preserve_newlines: 2,
        preserve_newlines: true,
        end_with_newline: false,
      });
    } catch {
      return code;
    }
  }
}
