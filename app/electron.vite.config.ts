import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * Content-Security-Policy только в сборке: у dev-сервера inline-скрипт HMR, ему CSP мешает.
 * `style-src 'unsafe-inline'` нужен для атрибутов `style` у React; скрипты только из `self`, сеть закрыта.
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
    // Без `data:`-шрифтов: Vite встраивает мелкие файлы base64, а CSP (`font-src 'self'`) такие шрифты блокирует
    // (e2e поймал console.error на каждый). Все ресурсы остаются файлами.
    build: { assetsInlineLimit: 0 },
  },
})
