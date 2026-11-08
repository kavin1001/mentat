import { useEffect, useState } from 'react'
import type { Template } from '../../shared/types'
import { api } from './api'

const blank = (): Template => ({ id: '', name: 'New template', description: '', sections: ['Key points', 'Next steps'], instructions: '' })

export function TemplatesView() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [edit, setEdit] = useState<Template | null>(null)

  const load = () => api.templates.list().then(setTemplates)
  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="page">
      <div className="row">
        <h2>Templates</h2>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEdit(blank())}>
          + New template
        </button>
      </div>
      <p className="muted">A template sets the sections and tone Claude uses when it enhances your notes.</p>
      <div className="grid">
        {templates.map((t) => (
          <div key={t.id} className="card tpl">
            <h3>{t.name}</h3>
            <p className="muted small">{t.description}</p>
            <ol className="small">
              {t.sections.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div className="row">
              {t.builtIn ? (
                <button className="btn" onClick={() => setEdit({ ...t, id: '', name: `${t.name} (copy)`, builtIn: false })}>
                  Duplicate
                </button>
              ) : (
                <>
                  <button className="btn" onClick={() => setEdit(t)}>
                    Edit
                  </button>
                  <button className="btn ghost danger" onClick={async () => { await api.templates.remove(t.id); void load() }}>
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{edit.id ? 'Edit template' : 'New template'}</h3>
            <label>
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </label>
            <label>
              Description
              <input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </label>
            <label>
              Sections (one per line)
              <textarea rows={6} value={edit.sections.join('\n')} onChange={(e) => setEdit({ ...edit, sections: e.target.value.split('\n') })} />
            </label>
            <label>
              Instructions for Claude
              <textarea rows={3} value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} />
            </label>
            <div className="row end">
              <button className="btn" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  await api.templates.save({ ...edit, sections: edit.sections.map((s) => s.trim()).filter(Boolean) })
                  setEdit(null)
                  void load()
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
