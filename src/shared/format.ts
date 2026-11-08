import type { Meeting, TranscriptSegment } from './types'

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function speakerLabel(seg: TranscriptSegment): string {
  if (seg.speaker === 'me') return 'Me'
  return seg.speakerIndex !== undefined && seg.speakerIndex > 0 ? `Them (${seg.speakerIndex + 1})` : 'Them'
}

/** Merge consecutive segments from the same speaker into readable turns. */
export function transcriptTurns(segments: TranscriptSegment[]): { label: string; start: number; text: string }[] {
  const turns: { label: string; start: number; text: string }[] = []
  for (const seg of [...segments].sort((a, b) => a.start - b.start)) {
    const label = speakerLabel(seg)
    const last = turns[turns.length - 1]
    if (last && last.label === label) last.text += ' ' + seg.text
    else turns.push({ label, start: seg.start, text: seg.text })
  }
  return turns
}

export function transcriptToText(segments: TranscriptSegment[]): string {
  return transcriptTurns(segments)
    .map((t) => `[${fmtTime(t.start)}] ${t.label}: ${t.text}`)
    .join('\n')
}

export function transcriptToSrt(segments: TranscriptSegment[]): string {
  const ts = (x: number) => {
    const ms = Math.floor((x % 1) * 1000)
    const s = Math.floor(x)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  }
  return [...segments]
    .sort((a, b) => a.start - b.start)
    .map((seg, i) => `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${speakerLabel(seg)}: ${seg.text}\n`)
    .join('\n')
}

export function enhancedToMarkdown(m: Meeting): string {
  const e = m.enhanced
  if (!e) return m.notes
  const out: string[] = []
  if (e.summary) out.push(e.summary, '')
  for (const s of e.sections) {
    if (!s.bullets.length) continue
    out.push(`### ${s.heading}`)
    for (const b of s.bullets) out.push(`- ${b.text}`)
    out.push('')
  }
  if (e.actionItems.length) {
    out.push('### Action items')
    for (const a of e.actionItems) out.push(`- [ ] ${a.owner ? `**${a.owner}**: ` : ''}${a.text}${a.due ? ` (due ${a.due})` : ''}`)
    out.push('')
  }
  return out.join('\n').trim()
}

export function meetingToMarkdown(m: Meeting, opts: { includeTranscript?: boolean } = {}): string {
  const date = new Date(m.startedAt ?? m.createdAt)
  const out = [`# ${m.title}`, '', `*${date.toLocaleString()}*`]
  if (m.attendees.length) out.push('', `**Attendees:** ${m.attendees.map((a) => a.name ?? a.email).join(', ')}`)
  out.push('', '## Notes', '', m.enhanced ? enhancedToMarkdown(m) : m.notes || '_No notes_')
  if (m.enhanced && m.notes.trim()) out.push('', '## My raw notes', '', m.notes)
  if (opts.includeTranscript && m.transcript.length) out.push('', '## Transcript', '', transcriptToText(m.transcript))
  return out.join('\n') + '\n'
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Minimal Markdown to HTML, enough for Drive's Google Docs conversion. */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const html: string[] = []
  let inList = false
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
  for (const line of lines) {
    const li = line.match(/^\s*[-*] (\[ \] )?(.*)$/)
    if (li) {
      if (!inList) html.push('<ul>')
      inList = true
      html.push(`<li>${li[1] ? '☐ ' : ''}${inline(li[2])}</li>`)
      continue
    }
    if (inList) {
      html.push('</ul>')
      inList = false
    }
    const h = line.match(/^(#{1,6}) (.*)$/)
    if (h) html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`)
  }
  if (inList) html.push('</ul>')
  return `<html><body>${html.join('\n')}</body></html>`
}
