import type { Plugin } from 'vite';

/** Dev server only: mirrors the open game into .debug/. */
export function debugBridge(): Plugin;
