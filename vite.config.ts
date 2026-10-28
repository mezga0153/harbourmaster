/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { debugBridge } from './scripts/debug-bridge.mjs';

export default defineConfig({
  plugins: [debugBridge()],
  worker: { format: 'es' },
  test: { environment: 'node' },
});
