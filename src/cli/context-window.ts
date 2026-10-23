/**
 * How many tokens a model's context window holds.
 *
 * The bar can only say how full the conversation is against a window if the
 * window is known. The models this project runs on carry a million tokens, so
 * that is the default; a model known to be smaller is listed, and anything
 * unknown is assumed to be in the same class until the human says otherwise
 * with `--context-window`.
 */
export const DEFAULT_CONTEXT_WINDOW: number = 1_000_000;

/** The models known to carry less than the default. */
const WINDOWS: Readonly<Record<string, number>> = {
  'claude-sonnet-4-5': 200_000,
};

export function contextWindowFor(model: string, override: number | undefined): number {
  if (override !== undefined) {
    return override;
  }
  return WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}
