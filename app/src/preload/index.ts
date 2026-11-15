import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ChangedEvent, LoadoutApi } from '../shared/model'

const api: LoadoutApi = {
  scan: () => ipcRenderer.invoke('scan'),
  copyText: (text) => ipcRenderer.invoke('copyText', text),
  // страница получает только данные события, без объекта IpcRendererEvent и самого ipcRenderer
  onChanged: (cb) => {
    const handler = (_e: IpcRendererEvent, payload: ChangedEvent) => cb(payload)
    ipcRenderer.on('changed', handler)
    return () => {
      ipcRenderer.removeListener('changed', handler)
    }
  },
}

contextBridge.exposeInMainWorld('loadout', api)
