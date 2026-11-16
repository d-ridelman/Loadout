import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * Content-Security-Policy only in the build: the dev server has an inline HMR script, which the CSP would block.
 * `style-src 'unsafe-inline'` is needed for React's `style` attributes; scripts only from `self`, the network is closed.
 */
const csp: Plugin = {
  name: 'loadout-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'",
      },
      injectTo: 'head-prepend',
    },
  ],
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), csp],
    // No `data:` fonts: Vite inlines small files as base64, and the CSP (`font-src 'self'`) blocks such fonts
    // (e2e caught a console.error for each one). All resources stay as files.
    build: { assetsInlineLimit: 0 },
  },
})
