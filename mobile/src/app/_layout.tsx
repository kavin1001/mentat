import '../lib/polyfills'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { SyncProvider } from '../lib/sync'
import { colors } from '../lib/theme'

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SyncProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.paper },
            headerShadowVisible: false,
            headerTintColor: colors.accent,
            headerTitleStyle: { color: colors.ink, fontWeight: '600' },
            contentStyle: { backgroundColor: colors.paper }
          }}
        >
          <Stack.Screen name="index" options={{ title: 'Mentat', headerLargeTitle: true }} />
          <Stack.Screen name="meeting/[id]" options={{ title: '' }} />
          <Stack.Screen name="connect" options={{ title: 'Connect', presentation: 'modal' }} />
          <Stack.Screen name="scan" options={{ title: 'Scan pairing code', presentation: 'fullScreenModal' }} />
          <Stack.Screen name="settings" options={{ title: 'Sync & settings' }} />
        </Stack>
      </SyncProvider>
    </SafeAreaProvider>
  )
}
