import { Alert, Platform, ScrollView, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useSync } from '../lib/sync'
import { describe } from '../lib/connection'
import { colors } from '../lib/theme'
import { Button, Card, s } from '../components/ui'
import { ago } from '../components/SyncBadge'

const confirmAsync = (title: string, body: string, action: string) =>
  Platform.OS === 'web'
    ? Promise.resolve(window.confirm(`${title}\n\n${body}`))
    : new Promise<boolean>((resolve) =>
        Alert.alert(title, body, [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: action, style: 'destructive', onPress: () => resolve(true) }
        ])
      )

export default function SettingsScreen() {
  const { connection, status, store, syncNow, disconnect } = useSync()
  const notes = store.list('meeting').length
  const pending = store.pendingCount()

  const leave = async (deleteCloudProfile = false) => {
    const ok = await confirmAsync(
      deleteCloudProfile ? 'Delete cloud profile?' : connection?.type === 'local' ? 'Unpair this phone?' : 'Sign out?',
      deleteCloudProfile
        ? 'This deletes your profile and every synced note from the server. Notes on your computer are not affected.'
        : 'Synced notes are removed from this phone. They stay on your computer. Notes written here that haven’t synced yet are kept.',
      deleteCloudProfile ? 'Delete' : connection?.type === 'local' ? 'Unpair' : 'Sign out'
    )
    if (!ok) return
    try {
      await disconnect({ deleteCloudProfile })
    } catch (e) {
      Alert.alert('Couldn’t finish', (e as Error).message)
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Card>
        <Text style={s.h2}>{describe(connection)}</Text>
        {connection?.type === 'local' && (
          <Text style={s.p}>Syncing directly with your computer over Wi-Fi. No account, and notes never leave your network. Keep Mentat open on the computer to sync.</Text>
        )}
        {connection?.type === 'cloud' && (
          <Text style={s.p}>
            Signed in to <Text style={{ fontWeight: '600' }}>{connection.serverUrl}</Text>. Everything is encrypted on this phone before upload.
          </Text>
        )}
        {!connection && (
          <Text style={s.p}>Notes you write stay on this phone. Pair with your computer to see your meetings and sync these notes.</Text>
        )}
        {connection && (
          <Text style={[s.small, { marginTop: 8, color: status.error ? colors.warn : colors.ink3 }]}>
            {status.error ?? (status.syncing ? 'Syncing…' : `Last synced ${ago(status.lastSyncAt)}`)}
          </Text>
        )}
        <Text style={[s.small, { marginTop: 4 }]}>
          {notes} note{notes === 1 ? '' : 's'} on this phone{pending ? `, ${pending} waiting to sync` : ''}.
        </Text>
        <View style={{ gap: 10, marginTop: 14 }}>
          {connection && <Button title="Sync now" kind="primary" onPress={syncNow} busy={status.syncing} />}
          <Button title={connection ? 'Connect somewhere else' : 'Connect'} kind={connection ? 'default' : 'primary'} onPress={() => router.push('/connect')} />
          {connection && <Button title={connection.type === 'local' ? 'Unpair this phone' : 'Sign out'} onPress={() => void leave()} />}
          {connection?.type === 'cloud' && <Button title="Delete cloud profile" kind="danger" onPress={() => void leave(true)} />}
        </View>
      </Card>

      <Card>
        <Text style={s.h2}>Privacy</Text>
        <Text style={s.p}>
          Mentat has no account by default. Pairing uses a one-time code from your computer, and sync is end-to-end encrypted, whether it goes over your
          Wi-Fi or through an optional cloud server. Your cloud password never leaves your devices.
        </Text>
      </Card>
    </ScrollView>
  )
}
