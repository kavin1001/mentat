import { useRef, useState } from 'react'
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { router } from 'expo-router'
import { useSync } from '../lib/sync'
import { parsePairingCode } from '../lib/connection'
import { Button, s } from '../components/ui'

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions()
  const { pairWithComputer } = useSync()
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false })
  const handled = useRef(false)

  if (!permission) return null
  if (!permission.granted)
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 14 }}>
        <Text style={s.p}>Mentat needs the camera to scan the pairing code on your computer. It’s used for nothing else.</Text>
        {permission.canAskAgain ? (
          <Button title="Allow camera" kind="primary" onPress={requestPermission} />
        ) : (
          <Button title="Open Settings" kind="primary" onPress={() => Linking.openSettings()} />
        )}
        <Button title="Cancel" kind="ghost" onPress={() => router.back()} />
      </View>
    )

  const onScan = async (data: string) => {
    if (handled.current) return
    handled.current = true
    setState({ busy: true })
    try {
      await pairWithComputer(parsePairingCode(data))
      router.dismissAll()
    } catch (e) {
      setState({ busy: false, error: (e as Error).message })
      setTimeout(() => (handled.current = false), 2500)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => void onScan(r.data)} />
      <View style={st.frame} pointerEvents="none" />
      <View style={st.panel}>
        {state.busy ? (
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <ActivityIndicator color="#fff" />
            <Text style={st.text}>Connecting to your computer…</Text>
          </View>
        ) : (
          <Text style={st.text}>{state.error ?? 'Point at the code in Mentat on your computer (Settings → Phone on this network).'}</Text>
        )}
        <Button title="Cancel" kind="ghost" onPress={() => router.back()} style={{ marginTop: 8 }} />
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  frame: { position: 'absolute', alignSelf: 'center', top: '22%', width: 250, height: 250, borderRadius: 24, borderWidth: 3, borderColor: 'rgba(255,255,255,0.85)' },
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 24, paddingBottom: 44, backgroundColor: 'rgba(0,0,0,0.55)' },
  text: { color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center', flexShrink: 1 }
})

