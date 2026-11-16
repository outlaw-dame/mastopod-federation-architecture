// TypeScript handles name resolution and types; ESLint checks syntax hazards.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  env: { node: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
    'no-dupe-args': 'error',
    'no-duplicate-case': 'error',
    'no-unexpected-multiline': 'error',
    'valid-typeof': 'error',
    'constructor-super': 'error',
    'no-unsafe-finally': 'error'
  }
};
