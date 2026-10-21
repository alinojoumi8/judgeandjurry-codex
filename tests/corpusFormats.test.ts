import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { CaseStore } from '../server/db'
import { CorpusService } from '../server/corpus'

it('preserves mixed disclosure formats, exact sheet values and failed originals after parser upgrades', async () => {
  const root = mkdtempSync(join(tmpdir(), 'judge-jury-formats-'))
  const store = new CaseStore(':memory:')
  try {
    const folder = join(root, 'packet'); mkdirSync(folder)
    const workbook = new AdmZip()
    workbook.addFile('xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="Missing" r:id="missing"/><sheet name="Ledger &amp; notices" r:id="r1"/><sheet name="Other" r:id="r2"/></sheets></workbook>'))
    workbook.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="r1" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="r2" Target="./worksheets/sheet2.xml"/></Relationships>'))
    workbook.addFile('xl/sharedStrings.xml', Buffer.from('<sst><si><t>Fictional notice</t></si></sst>'))
    workbook.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><c r="A1" t="s"><v>0</v></c><c r="B1"><v>117</v></c><c r="C1" t="inlineStr"><is><t>Rowan &amp; Morgan</t></is></c><c t="s"><v>9</v></c><c r="D1"><v></v></c></worksheet>'))
    workbook.addFile('xl/worksheets/sheet2.xml', Buffer.from('<worksheet><c r="A2"><v>2</v></c></worksheet>'))
    workbook.writeZip(join(folder, 'ledger.xlsx'))
    new AdmZip().writeZip(join(folder, 'empty.xlsx'))
    writeFileSync(join(folder, 'note.eml'), 'Subject: Fictional notice\r\nFrom: Rowan <rowan@example.invalid>\r\nTo: Morgan <morgan@example.invalid>\r\nDate: Fri, 02 Oct 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="trial"\r\n\r\n--trial\r\nContent-Type: text/plain\r\n\r\nNotice delivered.\r\n--trial\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\nFictional attachment.\r\n--trial--')
    writeFileSync(join(folder, 'bare.eml'), 'Content-Type: text/html\r\n\r\n<p>Fictional HTML body.</p>')
    writeFileSync(join(folder, 'note.html'), '<html><body><p>Notice &amp; reply</p><script>private()</script></body></html>')
    writeFileSync(join(folder, 'note.rtf'), '{\\rtf1\\ansi Fictional notice\\par Next line}')
    writeFileSync(join(folder, 'bad.msg'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(folder, 'bad.docx'), Buffer.from('invalid archive'))
    const matter = store.createMatter({ title: 'Fictional format regression' })
    const service = new CorpusService(store, undefined, join(root, 'blobs'))
    await expect(service.previewFolder('relative')).rejects.toThrow(/absolute/)
    await expect(service.previewFolder(join(folder, 'note.html'))).rejects.toThrow(/not a folder/)
    await expect(service.previewZip(folder)).rejects.toThrow(/not a file/)
    const preview = await service.previewFolder(folder)
    expect(() => service.confirmPreview('missing', matter.id, false)).toThrow()
    const job = service.confirmPreview(preview.id, matter.id, false)
    expect((await service.runToCompletion(job.id)).status).toBe('completed')
    const entries = service.listManifest(job.id)
    const sheet = entries.find(e => e.relativePath === 'ledger.xlsx')!
    expect(service.listArtifacts(sheet.id).map(a => a.text).join('\n')).toContain('A1: Fictional notice')
    expect(service.listArtifacts(sheet.id)[0].text).toContain('C1: Rowan & Morgan')
    expect(entries.find(e => e.relativePath === 'empty.xlsx')?.status).toBe('needs_review')
    expect(entries.find(e => e.relativePath === 'bad.docx')?.status).toBe('needs_review')
    const mail = entries.find(e => e.relativePath === 'note.eml')!
    expect(service.listArtifacts(mail.id)).toHaveLength(2)
    expect(service.listArtifacts(mail.id)[0].text).toContain('Notice delivered.')
    expect(service.listArtifacts(mail.id)[1].warnings).toContain('Attachment remains preserved inside the source EML.')
    expect((await service.runToCompletion(job.id)).processedFiles).toBe(8)
  } finally { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

it('rejects changed, missing and non-file sources after preview without fabricating evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'judge-jury-source-drift-'))
  const store = new CaseStore(':memory:')
  try {
    const folder = join(root, 'packet'); mkdirSync(folder)
    for (const name of ['changed.txt', 'missing.txt', 'directory.txt']) writeFileSync(join(folder, name), `Original fictional account for ${name}.`)
    const matter = store.createMatter({ title: 'Fictional drift' })
    const service = new CorpusService(store, undefined, join(root, 'blobs'))
    const preview = await service.previewFolder(folder)
    writeFileSync(join(folder, 'changed.txt'), 'Changed fictional account.')
    rmSync(join(folder, 'missing.txt'))
    rmSync(join(folder, 'directory.txt')); mkdirSync(join(folder, 'directory.txt'))
    const job = service.confirmPreview(preview.id, matter.id, false)
    await service.runToCompletion(job.id)
    expect(service.listManifest(job.id).map(e => ({ path: e.relativePath, status: e.status, evidence: Boolean(e.evidenceId) }))).toEqual(['changed.txt', 'directory.txt', 'missing.txt'].map(path => ({ path, status: 'failed', evidence: false })))
    expect(service.listManifest(job.id).find(e => e.relativePath === 'changed.txt')?.warning).toMatch(/changed after preview/)
    expect(store.listEvidence(matter.id)).toEqual([])
  } finally { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

it('records a disappeared ZIP member as failed rather than substituting another source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'judge-jury-zip-drift-'))
  const store = new CaseStore(':memory:')
  try {
    const path = join(root, 'packet.zip')
    const zip = new AdmZip(); zip.addFile('original.txt', Buffer.from('Fictional original.')); zip.writeZip(path)
    const matter = store.createMatter({ title: 'Fictional ZIP drift' })
    const service = new CorpusService(store, undefined, join(root, 'blobs'))
    const preview = await service.previewZip(path)
    const changed = new AdmZip(); changed.addFile('replacement.txt', Buffer.from('Different fictional source.')); changed.writeZip(path)
    const job = service.confirmPreview(preview.id, matter.id, false)
    await service.runToCompletion(job.id)
    expect(service.listManifest(job.id)[0]).toMatchObject({ status: 'failed', evidenceId: undefined })
    expect(service.listManifest(job.id)[0].warning).toMatch(/no longer exists/)
    expect(store.listEvidence(matter.id)).toEqual([])
  } finally { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
