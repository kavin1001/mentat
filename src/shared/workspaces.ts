// Read side of shared workspaces, used by the app and the MCP server. Meetings other people share with
// you are synced (decrypted) into ~/Mentat/workspaces/<id>/, laid out like your own data folder, so the
// same Store reads them. What is there is exactly what your profile is allowed to see: the relay only
// serves a workspace to its members, and the folder is removed when you leave or are removed.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './store'
import type { LocalWorkspace, Meeting } from './types'

export function workspacesDir(dataDir: string): string {
  return join(dataDir, 'workspaces')
}

export function listLocalWorkspaces(dataDir: string): LocalWorkspace[] {
  const dir = workspacesDir(dataDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((d) => /^[0-9a-f]{32}$/.test(d))
    .flatMap((d) => {
      try {
        return [JSON.parse(readFileSync(join(dir, d, 'workspace.json'), 'utf8')) as LocalWorkspace]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function workspaceStore(dataDir: string, id: string): Store {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`bad workspace id: ${id}`)
  return new Store(join(workspacesDir(dataDir), id))
}

/** True if `m` (one of your own meetings) is shared to workspace `wsId`, directly or through its folder. */
export function isSharedTo(m: Meeting, wsId: string, folderWorkspaces: Map<string, string[] | undefined>): boolean {
  if (m.workspaceIds?.includes(wsId)) return true
  return m.folderIds.some((f) => folderWorkspaces.get(f)?.includes(wsId))
}
