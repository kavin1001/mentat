import { contextBridge, ipcRenderer } from 'electron'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function on(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  invoke,
  on
}

contextBridge.exposeInMainWorld('mentat', api)
export type MentatBridge = typeof api
