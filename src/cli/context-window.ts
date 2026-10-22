/**
 * How many tokens a model's context window holds.
 *
 * The bar can only say how full the conversation is against a window if the
 * window is known, and guessing one would be worse than not saying: a wrong
 * denominator turns a comfortable session into a nearly-full one. Only the
 * model this project ships with is listed; anything else is reported as an
 * absolute weight until the human says otherwise with `--context-window`.
 */
const WINDOWS: Readonly<Record<string, number>> = {
  'claude-sonnet-4-5': 200_000,
};

export function contextWindowFor(model: string, override: number | undefined): number | undefined {
  if (override !== undefined) {
    return override;
  }
  return WINDOWS[model];
}
