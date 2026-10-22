/**
 * The palette the terminal gets.
 *
 * The transcript and the code in it are drawn with the same few colours, so
 * they live in one place: a log line and a string in the code should not
 * be the same shade of green.
 */

export const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`;
export const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`;
export const red = (text: string): string => `\u001b[31m${text}\u001b[0m`;
export const green = (text: string): string => `\u001b[32m${text}\u001b[0m`;
export const yellow = (text: string): string => `\u001b[33m${text}\u001b[0m`;
export const blue = (text: string): string => `\u001b[34m${text}\u001b[0m`;
export const magenta = (text: string): string => `\u001b[35m${text}\u001b[0m`;
export const cyan = (text: string): string => `\u001b[36m${text}\u001b[0m`;
