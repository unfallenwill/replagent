// ESLint is used for exactly one thing in this repo: the cyclomatic complexity
// gate. Formatting and general linting live in Biome, architecture lives in
// dependency-cruiser, types live in tsc. One tool, one job.
import tseslint from 'typescript-eslint';

const COMPLEXITY_LIMIT = 10;

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // McCabe cyclomatic complexity: 1 + number of decision points.
      complexity: ['error', { max: COMPLEXITY_LIMIT }],
    },
  },
];
