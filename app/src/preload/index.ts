import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ChangedEvent, LoadoutApi, UpdatesInfo } from '../shared/model'

const api: LoadoutApi = {
  scan: () => ipcRenderer.invoke('scan'),
  copyText: (text) => ipcRenderer.invoke('copyText', text),
  getLang: () => ipcRenderer.invoke('lang:get'),
  setLang: (lang) => ipcRenderer.invoke('lang:set', lang),
  welcome: () => ipcRenderer.invoke('welcome:get'),
  welcomeDone: () => ipcRenderer.invoke('welcome:done'),
  getWriteLevel: () => ipcRenderer.invoke('writeLevel:get'),
  setWriteLevel: (level) => ipcRenderer.invoke('writeLevel:set', level),
  plan: (intent) => ipcRenderer.invoke('plan', intent),
  apply: (intent, baseSha) => ipcRenderer.invoke('apply', intent, baseSha),
  journal: () => ipcRenderer.invoke('journal'),
  pruneBackups: () => ipcRenderer.invoke('backups:prune'),
  rollback: (op) => ipcRenderer.invoke('rollback', op),
  rollbackBatch: (batch) => ipcRenderer.invoke('rollbackBatch', batch),
  profiles: () => ipcRenderer.invoke('profiles'),
  saveProfile: (name, items) => ipcRenderer.invoke('profileSave', name, items),
  deleteProfile: (name) => ipcRenderer.invoke('profileDelete', name),
  quarantineProfiles: () => ipcRenderer.invoke('profilesQuarantine'),
  planProfile: (name) => ipcRenderer.invoke('planProfile', name),
  applyProfile: (name, batchSha) => ipcRenderer.invoke('applyProfile', name, batchSha),
  ctxkitStatus: () => ipcRenderer.invoke('ctxkit:status'),
  ctxkitDoctor: () => ipcRenderer.invoke('ctxkit:doctor'),
  ctxkitReport: (days) => ipcRenderer.invoke('ctxkit:report', days),
  ctxkitSetup: (options, dryRun) => ipcRenderer.invoke('ctxkit:setup', options, dryRun),
  ctxkitUninstall: (options, dryRun) => ipcRenderer.invoke('ctxkit:uninstall', options, dryRun),
  pluginInstall: (spec, dryRun) => ipcRenderer.invoke('plugin:install', spec, dryRun),
  marketplaceAdd: (source, dryRun) => ipcRenderer.invoke('marketplace:add', source, dryRun),
  marketplaces: () => ipcRenderer.invoke('marketplace:catalog'),
  skillFetch: (source, dryRun) => ipcRenderer.invoke('skill:fetch', source, dryRun),
  // the page gets only the event data, without the IpcRendererEvent object or ipcRenderer itself
  onChanged: (cb) => {
    const handler = (_e: IpcRendererEvent, payload: ChangedEvent) => cb(payload)
    ipcRenderer.on('changed', handler)
    return () => {
      ipcRenderer.removeListener('changed', handler)
    }
  },
  updates: () => ipcRenderer.invoke('updates:get'),
  setAutoUpdate: (on) => ipcRenderer.invoke('updates:setAuto', on),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  openReleaseNotes: () => ipcRenderer.invoke('updates:notes'),
  onUpdates: (cb) => {
    const handler = (_e: IpcRendererEvent, info: UpdatesInfo) => cb(info)
    ipcRenderer.on('updates', handler)
    return () => {
      ipcRenderer.removeListener('updates', handler)
    }
  },
}

contextBridge.exposeInMainWorld('loadout', api)
