/// <reference types="vite/client" />
import type { LoadoutApi } from '../shared/model'

declare global {
  interface Window {
    /** Bridge from preload; the page has no other path to the main process. */
    loadout: LoadoutApi
  }
}

export {}
