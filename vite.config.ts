/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { debugBridge } from './scripts/debug-bridge.mjs';
import { version } from './scripts/version.mjs';

export default defineConfig({
  plugins: [debugBridge()],
  // Which version this is, for the play log (src/log/).
  define: { __VERSION__: JSON.stringify(version()) },
  worker: { format: 'es' },
  test: { environment: 'node' },
});
