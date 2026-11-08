// Rich-text notepad. Notes are still stored as Markdown (so Claude, Drive, the MCP server, the phone and
// plain-text files all keep working); the editor only changes how you write them.
import { useEffect, useRef } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'

interface Props {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
}

export function NoteEditor({ value, onChange, placeholder }: Props) {
  const lastEmitted = useRef(value)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: true, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? 'Write notes…' }),
      Markdown
    ],
    content: value,
    contentType: 'markdown',
    editorProps: { attributes: { class: 'note-editor', spellcheck: 'true' } },
    onUpdate: ({ editor }) => {
      const md = editor.getMarkdown()
      lastEmitted.current = md
      onChange(md)
    }
  })

  // Accept outside changes (e.g. sync from the phone) without clobbering what the user is typing.
  useEffect(() => {
    if (!editor || value === lastEmitted.current || editor.isFocused) return
    lastEmitted.current = value
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])

  if (!editor) return null
  return (
    <div className="note-editor-wrap">
      <BubbleMenu editor={editor} className="bubble-menu">
        <Btn editor={editor} label="B" title="Bold (⌘B)" active="bold" run={(e) => e.chain().focus().toggleBold().run()} />
        <Btn editor={editor} label="I" title="Italic (⌘I)" active="italic" run={(e) => e.chain().focus().toggleItalic().run()} />
        <Btn editor={editor} label="S" title="Strikethrough" active="strike" run={(e) => e.chain().focus().toggleStrike().run()} />
        <Btn editor={editor} label="H" title="Heading" active="heading" run={(e) => e.chain().focus().toggleHeading({ level: 3 }).run()} />
        <Btn editor={editor} label="•" title="Bullet list" active="bulletList" run={(e) => e.chain().focus().toggleBulletList().run()} />
        <Btn editor={editor} label="1." title="Numbered list" active="orderedList" run={(e) => e.chain().focus().toggleOrderedList().run()} />
        <Btn editor={editor} label="☐" title="Checklist" active="taskList" run={(e) => e.chain().focus().toggleTaskList().run()} />
        <Btn editor={editor} label="❝" title="Quote" active="blockquote" run={(e) => e.chain().focus().toggleBlockquote().run()} />
      </BubbleMenu>
      <EditorContent editor={editor} className="notepad" />
    </div>
  )
}

function Btn({ editor, label, title, active, run }: { editor: Editor; label: string; title: string; active: string; run: (e: Editor) => void }) {
  return (
    <button type="button" title={title} className={editor.isActive(active) ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => run(editor)}>
      {label}
    </button>
  )
}
