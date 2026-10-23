import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import request from 'supertest'
import { expect, it } from 'vitest'
import { CaseStore } from '../server/db'
import { createApp } from '../server/app'
import { createMatterArchive, importMatterArchive } from '../server/matterArchive'

it('persists private notes across restart and archive restore without putting them in evidence/model data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'triallens-notes-'))
  let store = new CaseStore(join(root, 'case.db'))
  try {
    const matter = store.createMatter({ title: 'Notes fixture', narrative: 'Fictional case.' })
    const other = store.createMatter({ title: 'Other matter', narrative: 'Separate scope.' })
    const evidence = store.addEvidence(matter.id, { name: 'fiction.txt', type: 'text', mimeType: 'text/plain', size: 7, text: 'Source.', summary: 'Source.', tags: [] })
    let app = createApp({ store })
    const route = `/api/matters/${matter.id}/evidence/${evidence.id}/note`
    expect((await request(app).get(route).expect(200)).body).toEqual({ note: '' })
    await request(app).put(route).send({ note: 'PRIVATE_NOTE_SENTINEL' }).expect(200)
    await request(app).put(route).send({ note: 42 }).expect(400)
    await request(app).put(route).send({ note: 'x'.repeat(20_001) }).expect(400)
    await request(app).put(route.replace(matter.id, other.id)).send({ note: 'wrong scope' }).expect(404)
    expect(JSON.stringify(store.getWorkspace(matter.id))).not.toContain('PRIVATE_NOTE_SENTINEL')
    const archive = await createMatterArchive(store, matter.id)
    store.close(); store = new CaseStore(join(root, 'case.db')); app = createApp({ store })
    expect((await request(app).get(route).expect(200)).body.note).toBe('PRIVATE_NOTE_SENTINEL')
    const imported = await importMatterArchive(store, archive)
    const copy = store.listEvidence(imported.id)[0]
    expect(store.getEvidenceNote(imported.id, copy.id)).toBe('PRIVATE_NOTE_SENTINEL')
    await request(app).put(route).send({ note: '' }).expect(200)
    expect(store.getEvidenceNote(matter.id, evidence.id)).toBe('')
    expect(store.getEvidenceNote(imported.id, copy.id)).toBe('PRIVATE_NOTE_SENTINEL')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('migrates an existing v8 evidence table transactionally and retains its original data', () => {
  const root = mkdtempSync(join(tmpdir(), 'triallens-note-migration-'))
  const path = join(root, 'case.db')
  let store = new CaseStore(path)
  const matter = store.createMatter({ title: 'Migration fixture', narrative: '' })
  const evidence = store.addEvidence(matter.id, { name: 'source.txt', type: 'text', mimeType: 'text/plain', size: 1, text: 'Preserved', summary: '', tags: [] })
  store.close()
  const db = new DatabaseSync(path)
  db.exec('ALTER TABLE evidence DROP COLUMN private_note; PRAGMA user_version = 8'); db.close()
  store = new CaseStore(path)
  try { expect(store.getEvidence(evidence.id).text).toBe('Preserved'); expect(store.getEvidenceNote(matter.id, evidence.id)).toBe('') }
  finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
