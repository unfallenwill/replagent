import { hash } from '../files.js';
import type { EvalCheck } from '../types.js';

export function unit(body: string): string {
  return `await step("work", "complete and verify the requested change", async () => { ${body} });`;
}

export function write(files: Readonly<Record<string, string>>, answer = 'Done'): string {
  return unit(
    `const fs=require("node:fs"),path=require("node:path");for(const [p,s] of Object.entries(${JSON.stringify(files)})){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s)}say(${JSON.stringify(answer)});`,
  );
}

/** An imported candidate calling process.exit(0) must not bypass assertions. */
export function functional(id: string, code: string, afterTurn?: number): EvalCheck {
  const marker = `assertions-completed-${hash(code).slice(0, 16)}`;
  const test = `import assert from 'node:assert/strict';\n${code}\nconsole.log(${JSON.stringify(marker)});`;
  return {
    id,
    type: 'node',
    code:
      `import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';` +
      `const r=spawnSync(process.execPath,['--input-type=module','--eval',${JSON.stringify(test)}],{encoding:'utf8',timeout:8000});` +
      `assert.equal(r.status,0,r.stderr||r.error?.message);assert.ok(r.stdout.trim().endsWith(${JSON.stringify(marker)}),'Assertions were bypassed: '+r.stdout);`,
    ...(afterTurn === undefined ? {} : { afterTurn }),
  };
}

export function preserved(
  fixtures: Readonly<Record<string, string>>,
  paths: readonly string[],
): EvalCheck[] {
  return paths.map((file) => {
    if (fixtures[file] === undefined) throw new Error(`Missing protected fixture: ${file}`);
    return { id: `preserve:${file}`, type: 'unchanged', path: file };
  });
}

export const PACKAGE: string = `${JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs' } }, null, 2)}\n`;

export function publicTests(afterTurn?: number): EvalCheck {
  return functional(
    'existing-tests',
    `import {spawnSync} from 'node:child_process';import {readdirSync} from 'node:fs';const files=readdirSync('test').filter(x=>x.endsWith('.test.mjs')).map(x=>'test/'+x);assert.ok(files.length);const r=spawnSync(process.execPath,['--test',...files],{encoding:'utf8',timeout:6000});assert.equal(r.status,0,r.stdout+r.stderr);`,
    afterTurn,
  );
}
