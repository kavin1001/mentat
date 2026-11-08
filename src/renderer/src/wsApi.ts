import type { WorkspaceInviteView, WorkspaceMemberView, WorkspacesStatus } from '../../main/sync/workspaces'
import type { LocalWorkspace, Meeting, MeetingSummary } from '../../shared/types'

const inv = <T,>(ch: string, ...args: unknown[]) => window.mentat.invoke(ch, ...args) as Promise<T>

export type { WorkspacesStatus, WorkspaceMemberView, WorkspaceInviteView }

export const wsApi = {
  status: () => inv<WorkspacesStatus>('ws:status'),
  sync: () => inv<WorkspacesStatus>('ws:sync'),
  create: (name: string) => inv<WorkspacesStatus>('ws:create', name),
  detail: (id: string) => inv<{ members: WorkspaceMemberView[]; invites: WorkspaceInviteView[] }>('ws:detail', id),
  invite: (id: string, role: 'editor' | 'viewer', days?: number) => inv<{ code: string; expiresAt: string }>('ws:invite', id, role, days),
  revokeInvite: (id: string, inviteId: string) => inv<void>('ws:revokeInvite', id, inviteId),
  join: (code: string) => inv<WorkspacesStatus>('ws:join', code),
  setRole: (id: string, username: string, role: 'editor' | 'viewer') => inv<WorkspacesStatus>('ws:setRole', id, username, role),
  removeMember: (id: string, username: string) => inv<WorkspacesStatus>('ws:removeMember', id, username),
  leave: (id: string) => inv<WorkspacesStatus>('ws:leave', id),
  remove: (id: string) => inv<WorkspacesStatus>('ws:delete', id),
  shareFolder: (id: string, folderId: string, shared: boolean) => inv<WorkspacesStatus>('ws:shareFolder', id, folderId, shared),
  shareMeeting: (id: string, meetingId: string, shared: boolean) => inv<WorkspacesStatus>('ws:shareMeeting', id, meetingId, shared),
  local: () => inv<LocalWorkspace[]>('ws:local'),
  meetings: (id: string, query?: string) => inv<MeetingSummary[]>('ws:meetings', id, query),
  meeting: (id: string, meetingId: string) => inv<Meeting | null>('ws:meeting', id, meetingId),
  onStatus: (cb: (s: WorkspacesStatus) => void) => window.mentat.on('ws:status', cb)
}
