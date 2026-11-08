import { type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native'
import { colors } from '../lib/theme'

export function Button({
  title,
  onPress,
  kind = 'default',
  disabled,
  busy,
  style
}: {
  title: string
  onPress: () => void
  kind?: 'primary' | 'default' | 'danger' | 'ghost'
  disabled?: boolean
  busy?: boolean
  style?: ViewStyle
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, s[kind], (disabled || busy) && { opacity: 0.5 }, pressed && { opacity: 0.8 }, style]}
    >
      {busy ? (
        <ActivityIndicator color={kind === 'primary' ? '#fff' : colors.accent} />
      ) : (
        <Text style={[s.btnText, kind === 'primary' && { color: '#fff' }, kind === 'danger' && { color: colors.danger }, kind === 'ghost' && { color: colors.accent }]}>
          {title}
        </Text>
      )}
    </Pressable>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.ink3} autoCapitalize="none" autoCorrect={false} {...props} style={[s.input, props.style]} />
    </View>
  )
}

export const s = StyleSheet.create({
  btn: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  default: {},
  danger: { borderColor: '#f0cdc9' },
  ghost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  btnText: { fontSize: 15, fontWeight: '600', color: colors.ink },
  card: { backgroundColor: colors.panel, borderRadius: 14, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: '600', color: colors.ink2, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.ink, backgroundColor: '#fdfcfa' },
  h2: { fontSize: 17, fontWeight: '700', color: colors.ink, marginBottom: 6 },
  p: { fontSize: 14, lineHeight: 20, color: colors.ink2 },
  small: { fontSize: 12, lineHeight: 17, color: colors.ink3 }
})
