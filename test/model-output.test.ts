import { describe, expect, it } from 'vitest';
import { prepareModelOutput } from '../src/domain/model-output.js';

describe('prepareModelOutput', () => {
  it('passes plain javascript through', () => {
    const prepared = prepareModelOutput('const a = 1;\nconsole.log(a);');
    expect(prepared.code).toBe('const a = 1;\nconsole.log(a);');
    expect(prepared.unwrappedToolCall).toBe(false);
    expect(prepared.invalidSyntax).toBe(false);
    expect(prepared.problem).toBeUndefined();
  });

  it('flags prose as invalid javascript', () => {
    const prepared = prepareModelOutput('Sure! Here is how you do it:');
    expect(prepared.invalidSyntax).toBe(true);
  });

  it('reports an empty reply', () => {
    const prepared = prepareModelOutput('   ');
    expect(prepared.problem).toBeDefined();
    expect(prepared.code).toBe('');
  });

  it('accepts top level await', () => {
    const prepared = prepareModelOutput('await Promise.resolve(1)');
    expect(prepared.invalidSyntax).toBe(false);
  });

  it('unwraps a minimax style envelope with a content section', () => {
    const raw = [
      ']<]minimax[>[<tool_call>',
      ']<]minimax[>[<invoke name>',
      ']<]minimax[>[<content>const now = new Date();\nconsole.log(now);</content>',
      ']<]minimax[>[</invoke>',
      ']<]minimax[>[</tool_call>',
    ].join('\n');

    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe('const now = new Date();\nconsole.log(now);');
    expect(prepared.problem).toBeUndefined();
  });

  it('unwraps a minimax style envelope whose payload sits in the invoke section', () => {
    const raw = [
      ']<]minimax[>[<tool_call>',
      ']<]minimax[>[<invoke name>const now = new Date();',
      'console.log(now);',
      ']<]minimax[>[</invoke>',
      ']<]minimax[>[</tool_call>',
    ].join('\n');

    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe('const now = new Date();\nconsole.log(now);');
  });

  it('keeps the code when a tool call envelope follows it', () => {
    const raw = [
      'const url = "https://example.com";',
      'const response = await fetch(url);',
      'console.log(response.status);',
      '',
      '<tool_call>{"name": "fetch", "arguments": {"url": "https://example.com"}}</tool_call>',
    ].join('\n');

    const prepared = prepareModelOutput(raw);

    expect(prepared.problem).toBeUndefined();
    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe(
      'const url = "https://example.com";\nconst response = await fetch(url);\nconsole.log(response.status);',
    );
  });

  it('keeps the code when an invoke envelope follows it', () => {
    const raw = [
      'console.log("hello");',
      '<invoke name="fetch"><content>console.log("payload")</content></invoke>',
    ].join('\n');

    const prepared = prepareModelOutput(raw);

    expect(prepared.problem).toBeUndefined();
    expect(prepared.code).toBe('console.log("hello");');
  });

  it('unwraps an openai style tool call', () => {
    const raw =
      '<tool_call>\n{"name": "repl", "arguments": {"code": "const a = 1;\\nconsole.log(a);"}}\n</tool_call>';

    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe('const a = 1;\nconsole.log(a);');
  });

  it('unwraps a tool call whose payload is under an unknown key', () => {
    const raw =
      '<tool_call>{"name": "repl", "parameters": {"program": "const a = 1;\\nconsole.log(a);"}}</tool_call>';

    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe('const a = 1;\nconsole.log(a);');
  });

  it('unwraps an anthropic style json tool call', () => {
    const raw = '<tool_call>{"name": "repl", "input": {"code": "1 + 1"}}</tool_call>';

    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe('1 + 1');
  });

  it('unwraps a markdown code fence', () => {
    const raw = 'Here you go:\n```js\nconst a = 1;\nconsole.log(a);\n```';

    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe('const a = 1;\nconsole.log(a);');
  });

  it('reports a tool call without a usable payload', () => {
    const prepared = prepareModelOutput('<tool_call>{"name": "search"}</tool_call>');

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.problem).toBeDefined();
  });

  it('does not touch javascript that merely mentions the word tool', () => {
    const raw = 'const label = "tool_call";\nconsole.log(label);';
    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(false);
    expect(prepared.code).toBe(raw);
  });

  it('does not touch ordinary comparisons', () => {
    const raw = 'const smaller = 1<2;\nconsole.log(smaller);';
    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(false);
    expect(prepared.code).toBe(raw);
  });

  it('runs a program that mentions a tag', () => {
    const raw = 'const html = "<div>hello</div>";\nconsole.log(html.length);';
    const prepared = prepareModelOutput(raw);

    expect(prepared.problem).toBeUndefined();
    expect(prepared.invalidSyntax).toBe(false);
    expect(prepared.unwrappedToolCall).toBe(false);
    expect(prepared.code).toBe(raw);
  });

  it('does not lift a content section out of a program', () => {
    const raw = 'const s = "<content>x</content>";\nconsole.log(s.length);';
    const prepared = prepareModelOutput(raw);

    expect(prepared.problem).toBeUndefined();
    expect(prepared.code).toBe(raw);
  });

  it('runs a program that mentions a code fence', () => {
    const raw = 'const s = "```js\\ncode\\n```";\nconsole.log(s.length);';
    const prepared = prepareModelOutput(raw);

    expect(prepared.problem).toBeUndefined();
    expect(prepared.code).toBe(raw);
  });

  it('unwraps a tool call that arrived as bare json', () => {
    const raw = '{"name": "repl", "input": {"code": "console.log(1)"}}';
    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(true);
    expect(prepared.code).toBe('console.log(1)');
    expect(prepared.problem).toBeUndefined();
  });

  it('leaves a json program that is not a tool call alone', () => {
    const raw = '{"answer": 42}';
    const prepared = prepareModelOutput(raw);

    expect(prepared.unwrappedToolCall).toBe(false);
    expect(prepared.code).toBe(raw);
  });

  it('reports prose as prose, not as a tool call', () => {
    const prepared = prepareModelOutput('Sure! Here is how you do it:');

    expect(prepared.problem).toBeUndefined();
    expect(prepared.invalidSyntax).toBe(true);
  });

  it('strips invisible characters injected by gateways', () => {
    const prepared = prepareModelOutput('const a = 1;\nconsole.log(a);');
    expect(prepared.code).toBe('const a = 1;\nconsole.log(a);');
  });
});
