import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // The sender builds two role variants beside `dist/`, and scratch scripts
      // are named `.tmp-*`. Both are already in .gitignore; without them here,
      // `pnpm lint` reported thousands of errors in generated bundles and left a
      // real one nowhere to be seen.
      '**/dist-*/**',
      '**/.tmp-*',
      '**/node_modules/**',
      '**/out/**',
      '**/cache/**',
      '**/coverage/**',
      'packages/contracts/lib/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Node scripts, examples, and config files run outside the browser.
    files: ['**/scripts/**/*.{mjs,ts}', 'examples/**/*.mjs', '**/*.config.{js,ts,mjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
);
