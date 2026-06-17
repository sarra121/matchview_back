import { defineConfig } from 'vitest/config'

/**
 * The backend's own Vitest config.
 *
 * Without this file, Vitest walks UP the directory tree and finds the editor's
 * Vite config at the repo root — then tries to run these backend tests with the
 * frontend's browser-style setup (jsdom, WebGPU mocks, store resets). That
 * setup throws here. This config stops the upward search: backend tests run in
 * a plain Node environment with no inherited setup.
 */
export default defineConfig({
  test: {
    root: __dirname,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
