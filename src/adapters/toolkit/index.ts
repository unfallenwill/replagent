import { editTool } from './edit.js';
import { fileTools } from './files.js';
import { bashTool } from './shell.js';
import type { Toolkit, ToolkitOptions } from './toolkit.js';

/**
 * The toolkit, as one thing.
 *
 * Every helper takes the reason for the call as its second argument, and
 * every helper says what it did in a line the human can read. That is the
 * whole difference between this and calling `node:fs` directly: not the
 * capability, which JavaScript already had, but the intent, which the
 * transcript can then show.
 */
export function createToolkit(options: ToolkitOptions): Toolkit {
  return {
    ...fileTools(options),
    ...editTool(options),
    ...bashTool(options),
  };
}

export type {
  BashOptions,
  BashResult,
  EditChange,
  EditResult,
  ReadOptions,
  ToolAction,
  Toolkit,
  ToolkitOptions,
} from './toolkit.js';
