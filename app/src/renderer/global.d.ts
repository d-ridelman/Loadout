/// <reference types="vite/client" />
import type { LoadoutApi } from '../shared/model'

declare global {
  interface Window {
    /** Мост из preload; других путей к main-процессу у страницы нет. */
    loadout: LoadoutApi
  }
}

export {}
