import { contextBridge, ipcRenderer } from 'electron'
import type { LoadoutApi } from '../shared/model'

const api: LoadoutApi = {
  scan: () => ipcRenderer.invoke('scan'),
  copyText: (text) => ipcRenderer.invoke('copyText', text),
}

contextBridge.exposeInMainWorld('loadout', api)
