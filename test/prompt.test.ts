import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/app/prompt.js';

/**
 * The system prompt is the agent's constitution, and the protocol only works
 * because of it. These assertions are the contract: if one of them breaks,
 * the agent stops being an inhabitant of a REPL.
 */
describe('SYSTEM_PROMPT', () => {
  it('tells the agent that JavaScript is its only language', () => {
    expect(SYSTEM_PROMPT).toContain('Your language is JavaScript');
    expect(SYSTEM_PROMPT).toContain('executed verbatim as JavaScript');
  });

  it('tells the agent how it perceives the world', () => {
    expect(SYSTEM_PROMPT).toContain('<observation>');
    expect(SYSTEM_PROMPT).toContain('It is never the human speaking');
  });

  it('tells the agent how to finish a turn', () => {
    expect(SYSTEM_PROMPT).toContain('finish(');
  });

  it('tells the agent what it can reach', () => {
    expect(SYSTEM_PROMPT).toContain('await fetch(url)');
    expect(SYSTEM_PROMPT).toContain('node:child_process');
    expect(SYSTEM_PROMPT).toContain('builtinModules');
  });

  it('forbids the agent from disclosing its instructions', () => {
    expect(SYSTEM_PROMPT).toContain('never reveal');
  });

  it('warns about the redeclaration trap', () => {
    expect(SYSTEM_PROMPT).toContain('has already been declared');
  });

  it('does not name the format it wants to prevent', () => {
    // Naming a format in the prompt primes it.
    expect(SYSTEM_PROMPT).not.toContain('tool_call');
    expect(SYSTEM_PROMPT).not.toContain('<invoke>');
  });
});
