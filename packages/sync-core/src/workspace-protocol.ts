// Wire types for shared workspaces (cloud relay only). See workspace.ts for the key design.
//
//   POST   /v1/workspaces                               CreateWorkspaceRequest -> WorkspaceSummary   (any profile)
//   GET    /v1/workspaces                               -> { workspaces: WorkspaceSummary[] }        (your memberships)
//   GET    /v1/workspaces/:id                           -> WorkspaceDetail                           (member)
//   DELETE /v1/workspaces/:id                           -> {}                                         (owner; deletes everything)
//   POST   /v1/workspaces/:id/invites   CreateInviteRequest -> {}                                    (owner)
//   DELETE /v1/workspaces/:id/invites/:inviteId         -> {}                                         (owner)
//   POST   /v1/invites/redeem           RedeemInviteRequest -> RedeemInviteResponse                  (any profile)
//   PUT    /v1/workspaces/:id/members/me/bundle  { bundle, epoch } -> {}                            (member)
//   PATCH  /v1/workspaces/:id/members/:username  { role } -> {}                                     (owner)
//   DELETE /v1/workspaces/:id/members/:username         -> {}                                         (owner, or yourself to leave)
//   POST   /v1/workspaces/:id/rotate     RotateRequest -> {}                                         (owner)
//   GET    /v1/workspaces/:id/changes?since=N           -> PullResponse                              (member)
//   POST   /v1/workspaces/:id/changes    PushRequest     -> PushResponse                              (owner or editor)
//
// Access control the relay enforces: only members pull; only owners and editors push; a record can be
// overwritten only by the member who first wrote it, or by the owner; pushes must use the current key
// epoch (read from the blob's plaintext header), so nobody keeps writing with a key from before a rotation.

import { fromBase64 } from './encoding'

export type WorkspaceRole = 'owner' | 'editor' | 'viewer'
export const WORKSPACE_ROLES: WorkspaceRole[] = ['owner', 'editor', 'viewer']
export const canWrite = (r: WorkspaceRole) => r === 'owner' || r === 'editor'

export const WS_BLOB_VERSION = 2
export const INVITE_PREFIX = 'mentat-invite:'
export const WORKSPACE_ID_RE = /^[0-9a-f]{32}$/

/** The key epoch a workspace blob was encrypted with, from its plaintext header. */
export function blobEpoch(blobB64: string): number | null {
  try {
    // The 5 header bytes fit in the first 8 base64 characters.
    const b = fromBase64(blobB64.slice(0, 8))
    if (b.length < 5 || b[0] !== WS_BLOB_VERSION) return null
    return new DataView(b.buffer, b.byteOffset).getUint32(1)
  } catch {
    return null
  }
}

export interface WorkspaceSummary {
  id: string
  owner: string
  role: WorkspaceRole
  epoch: number
  /** Workspace name etc., encrypted with the keyring. */
  meta: string
  /** Your keyring, sealed to your identity key. Missing until you finish joining. */
  bundle?: string
  bundleEpoch?: number
  memberCount: number
  /** Owner only: someone left or was removed since the last key rotation. */
  rotateNeeded?: boolean
}

export interface WorkspaceMemberInfo {
  username: string
  role: WorkspaceRole
  publicKey: string
  /** MAC of username|publicKey under the invite's binding key ('' for the owner). */
  binding: string
  inviteId?: string
  joinedAt: string
  bundleEpoch?: number
}

export interface WorkspaceInviteInfo {
  id: string
  role: WorkspaceRole
  createdAt: string
  expiresAt: string
  usedBy?: string
  usedAt?: string
  /** The invite secret, encrypted with the keyring (so the owner can verify the invitee's binding later). */
  secretEnc: string
}

export interface WorkspaceDetail extends WorkspaceSummary {
  members: WorkspaceMemberInfo[]
  /** Owner only. */
  invites?: WorkspaceInviteInfo[]
}

export interface CreateWorkspaceRequest {
  id: string
  meta: string
  publicKey: string
  bundle: string
}

export interface CreateInviteRequest {
  id: string
  tokenHash: string
  role: Exclude<WorkspaceRole, 'owner'>
  wrapped: string
  secretEnc: string
  expiresAt: string
}

export interface RedeemInviteRequest {
  workspaceId: string
  token: string
  publicKey: string
  binding: string
}

export interface RedeemInviteResponse {
  workspaceId: string
  role: WorkspaceRole
  epoch: number
  wrapped: string
}

export interface RotateRequest {
  /** Must be the current epoch + 1. */
  epoch: number
  meta: string
  /** A sealed keyring for every current member, keyed by username. */
  bundles: Record<string, string>
}

/** What a `mentat-invite:` code encodes (base64url JSON). Share it privately, like a password. */
export interface InvitePayload {
  v: 1
  server: string
  workspaceId: string
  /** base64 32-byte invite secret */
  secret: string
  /** Workspace name, shown before joining. Informational only. */
  name?: string
  role?: WorkspaceRole
  invitedBy?: string
}
