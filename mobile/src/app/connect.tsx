// Choose what this phone syncs with. Pairing with your computer needs no account; cloud is optional.
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { MIN_PASSWORD_LENGTH } from '@mentat/sync-core'
import { useSync } from '../lib/sync'
import { parsePairingCode } from '../lib/connection'
import { colors } from '../lib/theme'
import { Button, Card, Field, s } from '../components/ui'

export default function ConnectScreen() {
  const { pairWithComputer, connectCloud, connection } = useSync()
  const [showCloud, setShowCloud] = useState(connection?.type === 'cloud')
  const [mode, setMode] = useState<'signin' | 'create'>('signin')
  const [code, setCode] = useState('')
  const [f, setF] = useState({ serverUrl: '', username: '', password: '', confirm: '', signupCode: '' })
  const [busy, setBusy] = useState<'pair' | 'cloud' | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const done = () => (router.canDismiss() ? router.dismissAll() : router.replace('/'))

  const pasteCode = async () => {
    setError(null)
    setBusy('pair')
    try {
      await pairWithComputer(parsePairingCode(code.trim()))
      done()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const cloud = async () => {
    setError(null)
    if (mode === 'create' && f.password !== f.confirm) return setError('The passwords don’t match.')
    setBusy('cloud')
    setProgress(0)
    try {
      await connectCloud({ ...f, create: mode === 'create', signupCode: f.signupCode || undefined }, setProgress)
      done()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Ionicons name="laptop-outline" size={20} color={colors.accent} />
            <Text style={[s.h2, { marginBottom: 0 }]}>Pair with your computer</Text>
          </View>
          <Text style={s.p}>
            Sync directly with Mentat on your computer over your Wi-Fi. No account, no password, nothing leaves your network.
          </Text>
          <Text style={[s.small, { marginTop: 8, marginBottom: 14 }]}>
            On your computer: Mentat → Settings → Phone on this network → Pair a phone.
          </Text>
          {Platform.OS !== 'web' && <Button title="Scan pairing code" kind="primary" onPress={() => router.push('/scan')} />}
          <View style={{ marginTop: 14 }}>
            <Field label="Or paste the pairing code" value={code} onChangeText={setCode} placeholder="mentat-pair:{…}" />
            <Button title="Pair" onPress={pasteCode} disabled={!code.trim()} busy={busy === 'pair'} />
          </View>
        </Card>

        {!showCloud ? (
          <Pressable onPress={() => setShowCloud(true)} style={{ padding: 12 }}>
            <Text style={{ color: colors.accent, fontWeight: '600', textAlign: 'center' }}>Use cloud sync instead (optional)</Text>
            <Text style={[s.small, { textAlign: 'center', marginTop: 4 }]}>Sync from anywhere with a password-protected profile.</Text>
          </Pressable>
        ) : (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Ionicons name="cloud-outline" size={20} color={colors.accent} />
              <Text style={[s.h2, { marginBottom: 0 }]}>Cloud profile</Text>
            </View>
            <Text style={[s.p, { marginBottom: 12 }]}>
              Sync from anywhere through a Mentat sync server. Notes are encrypted on your devices with a key made from your password, so the server
              can’t read them. If you forget the password, the synced copy can’t be recovered (notes on your computer are safe).
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <Button title="Sign in" kind={mode === 'signin' ? 'primary' : 'default'} onPress={() => setMode('signin')} style={{ flex: 1, paddingVertical: 8 }} />
              <Button title="Create profile" kind={mode === 'create' ? 'primary' : 'default'} onPress={() => setMode('create')} style={{ flex: 1, paddingVertical: 8 }} />
            </View>
            <Field label="Sync server" value={f.serverUrl} onChangeText={(v) => setF({ ...f, serverUrl: v })} placeholder="https://sync.example.com" keyboardType="url" />
            <Field label="Username" value={f.username} onChangeText={(v) => setF({ ...f, username: v })} textContentType="username" />
            <Field
              label={mode === 'create' ? `Password (at least ${MIN_PASSWORD_LENGTH} characters)` : 'Password'}
              value={f.password}
              onChangeText={(v) => setF({ ...f, password: v })}
              secureTextEntry
              textContentType={mode === 'create' ? 'newPassword' : 'password'}
            />
            {mode === 'create' && (
              <>
                <Field label="Confirm password" value={f.confirm} onChangeText={(v) => setF({ ...f, confirm: v })} secureTextEntry textContentType="newPassword" />
                <Field label="Signup code (if your server needs one)" value={f.signupCode} onChangeText={(v) => setF({ ...f, signupCode: v })} />
              </>
            )}
            <Button
              title={mode === 'create' ? 'Create profile' : 'Sign in'}
              kind="primary"
              onPress={cloud}
              busy={busy === 'cloud'}
              disabled={!f.serverUrl || !f.username || !f.password}
            />
            {busy === 'cloud' && (
              <View style={{ marginTop: 10 }}>
                <Text style={s.small}>Securing your password on this phone… {Math.round(progress * 100)}%</Text>
                <View style={{ height: 4, backgroundColor: colors.line, borderRadius: 2, marginTop: 6 }}>
                  <View style={{ height: 4, width: `${Math.round(progress * 100)}%`, backgroundColor: colors.accent, borderRadius: 2 }} />
                </View>
              </View>
            )}
          </Card>
        )}

        {error && <Text style={{ color: colors.danger, marginTop: 4, lineHeight: 20 }}>{error}</Text>}
        {connection && <Text style={[s.small, { marginTop: 12 }]}>Connecting somewhere new replaces your current connection. Notes you wrote on this phone that haven’t synced yet are kept.</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
