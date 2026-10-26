import { GRAPH_SCHEDULER } from '../long/graph.js';
import { functional, preserved, write } from '../long/helpers.js';
import { EVOLVING_POLICY } from '../long/policy.js';
import type { EvalTask } from '../types.js';

const fixtures = {
  'README.md': 'Build metadata is stored in config/build.json. Update only its revision field.\n',
  'config/build.json': '{"revision":1,"owner":"team","enabled":false}\n',
  'KEEP.txt': 'unchanged\n',
};

export const INSPECT_CHANGE: EvalTask = {
  id: 'experiment/development/inspect-change',
  suite: 'capability',
  partition: 'development',
  description: 'Inspect an unfamiliar directory and complete the requested change.',
  fixtures,
  turns: [
    'Inspect this project, find where README says the build revision is stored, and change the revision from 1 to 2. Preserve every other setting and file. Verify the saved value before reporting completion.',
  ],
  checks: [
    {
      id: 'changed',
      type: 'json',
      path: 'config/build.json',
      value: { revision: 2, owner: 'team', enabled: false },
    },
    ...preserved(fixtures, ['README.md', 'KEEP.txt']),
  ],
  reference: [write({ 'config/build.json': '{"revision":2,"owner":"team","enabled":false}\n' })],
};

export const LIST_ONLY: EvalTask = {
  id: 'experiment/development/list-only',
  suite: 'capability',
  partition: 'development',
  description: 'A directory observation is the legitimate final answer for this request.',
  fixtures,
  turns: [
    'List the immediate entries in this directory, showing a trailing / for directories. Do not inspect file contents or change anything.',
  ],
  checks: [
    ...['README.md', 'config/', 'KEEP.txt'].map((includes) => ({
      id: `listed:${includes}`,
      type: 'answer' as const,
      includes,
    })),
    ...preserved(fixtures, Object.keys(fixtures)),
    functional(
      'no-extra-files',
      `import fs from 'node:fs';assert.deepEqual(fs.readdirSync('.').sort(),['KEEP.txt','README.md','config']);`,
    ),
  ],
  reference: [
    'await step("list", "answer the directory listing request", async()=>{say((await ls(".","list entries")).join("\\n"));});',
  ],
};

/** Previously inspected failures are explicitly development data here. */
export const TASKS: readonly EvalTask[] = [
  INSPECT_CHANGE,
  LIST_ONLY,
  {
    ...GRAPH_SCHEDULER,
    id: 'experiment/development/dependency-scheduler',
    partition: 'development',
  },
  { ...EVOLVING_POLICY, id: 'experiment/development/evolving-policy', partition: 'development' },
];
