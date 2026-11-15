import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ChangedEvent, LoadoutApi } from '../shared/model'

const api: LoadoutApi = {
  scan: () => ipcRenderer.invoke('scan'),
  copyText: (text) => ipcRenderer.invoke('copyText', text),
  getLang: () => ipcRenderer.invoke('lang:get'),
  setLang: (lang) => ipcRenderer.invoke('lang:set', lang),
  getWriteLevel: () => ipcRenderer.invoke('writeLevel:get'),
  setWriteLevel: (level) => ipcRenderer.invoke('writeLevel:set', level),
  plan: (intent) => ipcRenderer.invoke('plan', intent),
  apply: (intent, baseSha) => ipcRenderer.invoke('apply', intent, baseSha),
  journal: () => ipcRenderer.invoke('journal'),
  rollback: (op) => ipcRenderer.invoke('rollback', op),
  rollbackBatch: (batch) => ipcRenderer.invoke('rollbackBatch', batch),
  profiles: () => ipcRenderer.invoke('profiles'),
  saveProfile: (name, items) => ipcRenderer.invoke('profileSave', name, items),
  deleteProfile: (name) => ipcRenderer.invoke('profileDelete', name),
  planProfile: (name) => ipcRenderer.invoke('planProfile', name),
  applyProfile: (name, batchSha) => ipcRenderer.invoke('applyProfile', name, batchSha),
  ctxkitStatus: () => ipcRenderer.invoke('ctxkit:status'),
  ctxkitDoctor: () => ipcRenderer.invoke('ctxkit:doctor'),
  ctxkitReport: (days) => ipcRenderer.invoke('ctxkit:report', days),
  ctxkitSetup: (options, dryRun) => ipcRenderer.invoke('ctxkit:setup', options, dryRun),
  pluginInstall: (spec, dryRun) => ipcRenderer.invoke('plugin:install', spec, dryRun),
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
