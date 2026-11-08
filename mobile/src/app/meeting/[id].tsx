// One meeting: your notes (editable, synced back to the computer), Claude's enhanced notes, and the full transcript.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useSync } from '../../lib/sync'
import { dayLabel, timeLabel } from '../../lib/meetings'
import { colors, serif } from '../../lib/theme'
import { fmtTime, transcriptTurns, type Folder, type Meeting } from '../../lib/types'

type Tab = 'notes' | 'enhanced' | 'transcript'

export default function MeetingScreen() {
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>()
  const { store, version } = useSync()
  const meeting = useMemo(() => store.get<Meeting>('meeting', id), [store, version, id])
  const folders = useMemo(() => store.list<Folder>('folder'), [store, version])
  const [tab, setTab] = useState<Tab>(() => (meeting?.enhanced ? 'enhanced' : 'notes'))

  // Local edit buffers, so a sync landing mid-typing doesn't move the cursor.
  const [title, setTitle] = useState(meeting?.title ?? '')
  const [notes, setNotes] = useState(meeting?.notes ?? '')
  const editing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!meeting || editing.current) return
    setTitle(meeting.title)
    setNotes(meeting.notes)
  }, [meeting?.title, meeting?.notes]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Partial<Meeting>) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const cur = store.get<Meeting>('meeting', id)
      if (cur) void store.put('meeting', { ...cur, ...patch })
      editing.current = false
    }, 600)
  }

  if (!meeting)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Stack.Screen options={{ title: '' }} />
        <Text style={{ color: colors.ink2, textAlign: 'center' }}>This note was deleted on another device.</Text>
      </View>
    )

  const turns = transcriptTurns(meeting.transcript ?? [])
  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'notes', label: 'My notes', show: true },
    { key: 'enhanced', label: 'Enhanced', show: !!meeting.enhanced },
    { key: 'transcript', label: `Transcript${turns.length ? ` · ${turns.length}` : ''}`, show: turns.length > 0 }
  ]
  const when = meeting.startedAt ?? meeting.createdAt
  const meetingFolders = folders.filter((f) => meeting.folderIds?.includes(f.id))

  const confirmDelete = () => {
    const go = async () => {
      await store.remove('meeting', id)
      router.back()
    }
    if (Platform.OS === 'web') return void go()
    Alert.alert('Delete this note?', 'It will also be deleted on your computer and anywhere else it syncs.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void go() }
    ])
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityLabel="Delete note" hitSlop={10} onPress={confirmDelete}>
              <Ionicons name="trash-outline" size={21} color={colors.accent} />
            </Pressable>
          )
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
        <TextInput
          value={title}
          onChangeText={(t) => {
            editing.current = true
            setTitle(t)
            save({ title: t })
          }}
          placeholder="Title"
          placeholderTextColor={colors.ink3}
          style={st.title}
          multiline
        />
        <View style={st.meta}>
          <Text style={st.metaText}>
            {dayLabel(when)}, {timeLabel(when)}
          </Text>
          {meeting.attendees?.length > 0 && (
            <Text style={st.metaText} numberOfLines={1}>
              · {meeting.attendees.map((a) => a.name || a.email.split('@')[0]).join(', ')}
            </Text>
          )}
          {meetingFolders.map((f) => (
            <Text key={f.id} style={st.pill}>
              {f.name}
            </Text>
          ))}
        </View>

        <View style={st.tabs}>
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={[st.tab, tab === t.key && st.tabOn]}>
                <Text style={[st.tabText, tab === t.key && { color: colors.ink }]}>{t.label}</Text>
              </Pressable>
            ))}
        </View>

        {tab === 'notes' && (
          <TextInput
            value={notes}
            onChangeText={(t) => {
              editing.current = true
              setNotes(t)
              save({ notes: t })
            }}
            autoFocus={focus === '1'}
            multiline
            scrollEnabled={false}
            placeholder="Write notes…"
            placeholderTextColor={colors.ink3}
            style={st.notes}
            textAlignVertical="top"
          />
        )}

        {tab === 'enhanced' && meeting.enhanced && (
          <View>
            {!!meeting.enhanced.summary && <Text style={st.summary}>{meeting.enhanced.summary}</Text>}
            {meeting.enhanced.sections.map((sec, i) => (
              <View key={i} style={{ marginTop: 18 }}>
                <Text style={st.h3}>{sec.heading}</Text>
                {sec.bullets.map((b, j) => (
                  <View key={j} style={st.bullet}>
                    <Text style={[st.bulletDot, b.origin === 'ai' && { color: colors.ai }]}>•</Text>
                    <Text style={[st.bulletText, b.origin === 'ai' && { color: colors.ai }]}>{b.text}</Text>
                  </View>
                ))}
              </View>
            ))}
            {meeting.enhanced.actionItems.length > 0 && (
              <View style={{ marginTop: 18 }}>
                <Text style={st.h3}>Action items</Text>
                {meeting.enhanced.actionItems.map((a, i) => (
                  <View key={i} style={st.bullet}>
                    <Ionicons name="square-outline" size={16} color={colors.ink3} style={{ marginTop: 2 }} />
                    <Text style={st.bulletText}>
                      {a.owner ? <Text style={{ fontWeight: '600' }}>{a.owner}: </Text> : null}
                      {a.text}
                      {a.due ? <Text style={{ color: colors.ink3 }}> (due {a.due})</Text> : null}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            <Text style={[st.metaText, { marginTop: 24 }]}>Dark text is from your notes; grey was added by Claude from the transcript.</Text>
          </View>
        )}

        {tab === 'transcript' &&
          turns.map((t, i) => (
            <View key={i} style={st.turn}>
              <Text style={[st.speaker, t.label === 'Me' && { color: colors.accent }]}>
                {t.label} <Text style={st.ts}>{fmtTime(t.start)}</Text>
              </Text>
              <Text selectable style={st.turnText}>
                {t.text}
              </Text>
            </View>
          ))}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

// Browsers draw a focus ring on inputs; the native apps don't.
const noOutline = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}

const st = StyleSheet.create({
  title: { ...noOutline, fontFamily: serif, fontSize: 28, fontWeight: '600', color: colors.ink, padding: 0 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 },
  metaText: { fontSize: 13, color: colors.ink3 },
  pill: { fontSize: 12, color: colors.accent, backgroundColor: colors.accentSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, overflow: 'hidden' },
  tabs: { flexDirection: 'row', gap: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, marginTop: 18, marginBottom: 14 },
  tab: { paddingVertical: 9, borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1 },
  tabOn: { borderBottomColor: colors.accent },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.ink3 },
  notes: { ...noOutline, fontSize: 16, lineHeight: 25, color: colors.ink, minHeight: 300, padding: 0 },
  summary: { fontSize: 16, lineHeight: 24, color: colors.ink2 },
  h3: { fontFamily: serif, fontSize: 19, fontWeight: '600', color: colors.ink, marginBottom: 6 },
  bullet: { flexDirection: 'row', gap: 8, marginVertical: 3 },
  bulletDot: { fontSize: 16, lineHeight: 23, color: colors.ink },
  bulletText: { flex: 1, fontSize: 15.5, lineHeight: 23, color: colors.ink },
  turn: { marginBottom: 14 },
  speaker: { fontSize: 13, fontWeight: '700', color: colors.ink2, marginBottom: 3 },
  ts: { fontWeight: '400', color: colors.ink3, fontVariant: ['tabular-nums'] },
  turnText: { fontSize: 15.5, lineHeight: 23, color: colors.ink }
})
