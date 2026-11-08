// Notes list: every meeting from the computer plus notes made on the phone, grouped by day.
import { useMemo, useState } from 'react'
import { Platform, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useSync } from '../lib/sync'
import { blankMeeting, dayLabel, displayTitle, folders as listFolders, preview, sortedMeetings, timeLabel } from '../lib/meetings'
import { colors, serif } from '../lib/theme'
import { SyncBadge } from '../components/SyncBadge'
import { Button } from '../components/ui'
import type { Meeting } from '../lib/types'

export default function NotesScreen() {
  const { ready, store, version, connection, status, syncNow } = useSync()
  const [query, setQuery] = useState('')
  const [folderId, setFolderId] = useState<string | undefined>()
  const insets = useSafeAreaInsets()

  const folders = useMemo(() => listFolders(store), [store, version])
  const sections = useMemo(() => {
    const groups = new Map<string, Meeting[]>()
    for (const m of sortedMeetings(store, { query, folderId })) {
      const k = dayLabel(m.startedAt ?? m.createdAt)
      groups.set(k, [...(groups.get(k) ?? []), m])
    }
    return [...groups].map(([title, data]) => ({ title, data }))
  }, [store, version, query, folderId])

  const newNote = async () => {
    const m = await store.put('meeting', blankMeeting())
    router.push({ pathname: '/meeting/[id]', params: { id: m.id, focus: '1' } })
  }

  if (!ready) return null
  const empty = sections.length === 0

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityLabel="Sync and settings" hitSlop={10} onPress={() => router.push('/settings')}>
              <Ionicons name="settings-outline" size={22} color={colors.accent} />
            </Pressable>
          )
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(m) => m.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        refreshControl={connection ? <RefreshControl refreshing={status.syncing} onRefresh={syncNow} tintColor={colors.accent} /> : undefined}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View>
            <SyncBadge />
            <View style={st.search}>
              <Ionicons name="search" size={16} color={colors.ink3} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search notes and transcripts"
                placeholderTextColor={colors.ink3}
                style={[{ flex: 1, fontSize: 15, color: colors.ink, paddingVertical: 8 }, Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)]}
                clearButtonMode="while-editing"
                returnKeyType="search"
              />
            </View>
            {folders.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 6 }} contentContainerStyle={{ gap: 8 }}>
                {[{ id: undefined, name: 'All notes' }, ...folders].map((f) => (
                  <Pressable key={f.id ?? 'all'} onPress={() => setFolderId(f.id)} style={[st.chip, folderId === f.id && st.chipOn]}>
                    <Text style={[st.chipText, folderId === f.id && { color: colors.accent }]}>{f.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        }
        renderSectionHeader={({ section }) => <Text style={st.section}>{section.title}</Text>}
        renderItem={({ item: m }) => (
          <Pressable onPress={() => router.push({ pathname: '/meeting/[id]', params: { id: m.id } })} style={({ pressed }) => [st.row, pressed && { opacity: 0.7 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={st.title} numberOfLines={1}>
                {displayTitle(m)}
              </Text>
              <Text style={st.time}>{timeLabel(m.startedAt ?? m.createdAt)}</Text>
            </View>
            {!!preview(m) && preview(m) !== displayTitle(m) && (
              <Text style={st.preview} numberOfLines={2}>
                {preview(m)}
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
              {m.enhanced && <Tag icon="sparkles-outline" text="Notes" />}
              {(m.transcript?.length ?? 0) > 0 && <Tag icon="chatbubbles-outline" text="Transcript" />}
              {(m.attendees?.length ?? 0) > 0 && <Tag icon="people-outline" text={String(m.attendees.length)} />}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: 20 }}>
            <Text style={{ fontFamily: serif, fontSize: 24, color: colors.ink, marginBottom: 8 }}>{query ? 'No matches' : 'No notes yet'}</Text>
            <Text style={{ color: colors.ink2, textAlign: 'center', lineHeight: 20, marginBottom: 20 }}>
              {query
                ? 'Nothing in your notes or transcripts matches that.'
                : connection
                  ? 'Meetings you record on your computer show up here.'
                  : 'Connect to Mentat on your computer to see your meetings here, or jot a note on this phone.'}
            </Text>
            {!connection && !query && <Button title="Connect to my computer" kind="primary" onPress={() => router.push('/connect')} />}
          </View>
        }
      />
      <Pressable accessibilityLabel="New note" onPress={newNote} style={[st.fab, { bottom: insets.bottom + 20 }]}>
        <Ionicons name="create-outline" size={20} color="#fff" />
        <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>{empty ? 'New note' : 'Note'}</Text>
      </Pressable>
    </View>
  )
}

function Tag({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Ionicons name={icon} size={13} color={colors.ink3} />
      <Text style={{ fontSize: 12, color: colors.ink3 }}>{text}</Text>
    </View>
  )
}

const st = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.panel, borderRadius: 10, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginVertical: 8 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.panel },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 13, color: colors.ink2, fontWeight: '500' },
  section: { fontSize: 12, fontWeight: '700', color: colors.ink3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 18, marginBottom: 6 },
  row: { backgroundColor: colors.panel, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  title: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.ink },
  time: { fontSize: 12, color: colors.ink3, fontVariant: ['tabular-nums'] },
  preview: { fontSize: 14, color: colors.ink2, marginTop: 4, lineHeight: 19 },
  fab: { position: 'absolute', right: 20, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 14, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 }
})
