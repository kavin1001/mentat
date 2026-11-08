import { Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useSync } from '../lib/sync'
import { colors } from '../lib/theme'
import { describe } from '../lib/connection'

export function ago(iso?: string): string {
  if (!iso) return 'not yet'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export function SyncBadge() {
  const { connection, status, store } = useSync()
  const pending = store.pendingCount()
  const dot = !connection ? colors.ink3 : status.error ? colors.warn : colors.accent
  const detail = !connection
    ? pending
      ? `${pending} note${pending === 1 ? '' : 's'} not synced · Connect`
      : 'Connect to your computer'
    : status.error
      ? status.error
      : status.syncing
        ? 'Syncing…'
        : `Synced ${ago(status.lastSyncAt)}`
  return (
    <Pressable onPress={() => router.push(connection ? '/settings' : '/connect')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <Text style={{ fontSize: 13, color: colors.ink2, flexShrink: 1 }} numberOfLines={2}>
        <Text style={{ fontWeight: '600', color: colors.ink }}>{describe(connection)}</Text> · {detail}
      </Text>
    </Pressable>
  )
}
