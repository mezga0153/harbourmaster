/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  test: { environment: 'node' },
});
