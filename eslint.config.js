// The old app's rules (table-function-visualizer apps/web/.eslintrc.cjs) in flat config.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist', 'site', '**/node_modules', '.venv', '.claude'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: { globals: globals.browser },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      // react-hooks 7's recommended set adds the React Compiler rules; keep the old app's two
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/scripts/**/*.mjs', '**/vite.config.ts', 'packages/runtime-pyodide/src/vite.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Functions passed to page.evaluate and addInitScript run in the browser
    files: ['scripts/record-demos.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['packages/runtime-pyodide/src/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
);
