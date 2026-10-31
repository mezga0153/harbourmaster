/// <reference types="vitest/config" />
import { configDefaults, defineConfig } from 'vitest/config';
import { debugBridge } from './scripts/debug-bridge.mjs';
import { version } from './scripts/version.mjs';

export default defineConfig({
  plugins: [debugBridge()],
  // Which version this is, for the play log (src/log/).
  define: { __VERSION__: JSON.stringify(version()) },
  worker: { format: 'es' },
  // Other sessions' worktrees under .claude/ have their own tests; they are not this tree's.
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
