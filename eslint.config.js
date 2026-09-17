import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist-*', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', indexedDB: 'readonly', crypto: 'readonly', HTMLElement: 'readonly', CustomEvent: 'readonly', Event: 'readonly', MessageEvent: 'readonly', MutationObserver: 'readonly', Node: 'readonly', Element: 'readonly', HTMLInputElement: 'readonly', HTMLTextAreaElement: 'readonly', HTMLSelectElement: 'readonly', HTMLOptionElement: 'readonly', HTMLDetailsElement: 'readonly', customElements: 'readonly', location: 'readonly', fetch: 'readonly', localStorage: 'readonly', URL: 'readonly', Blob: 'readonly', FileReader: 'readonly', requestAnimationFrame: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly', btoa: 'readonly', atob: 'readonly', Image: 'readonly', CSS: 'readonly' } }
  }
);
