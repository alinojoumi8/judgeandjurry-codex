import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { listCuratedAuthorities } from '../server/authorityRegistry'
import { CaseStore } from '../server/db'
import { apiSecurityConfig, assertSafeBindConfiguration } from '../server/security'
import { TrialForgeService } from '../server/trialforge'

const tempRoot = mkdtempSync(join(tmpdir(), 'judge-jury-hardening-'))
const previousEvidenceRoot = process.env.EVIDENCE_STORAGE_DIR

beforeAll(() => {
  process.env.EVIDENCE_STORAGE_DIR = join(tempRoot, 'evidence')
})

afterAll(() => {
  if (previousEvidenceRoot === undefined) {
    delete process.env.EVIDENCE_STORAGE_DIR
  } else {
    process.env.EVIDENCE_STORAGE_DIR = previousEvidenceRoot
  }
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('release hardening', () => {
  it('preserves, hashes, downloads, and archives original evidence without reusing exhibit ids', async () => {
    const store = new CaseStore(':memory:')
    const app = createApp({ store })
    const created = await request(app).post('/api/matters').send({ title: 'Integrity' }).expect(201)
    const matterId = created.body.activeMatter.id as string
    const source = Buffer.from('immutable source bytes')

    const uploaded = await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach('file', source, 'source.txt')
      .expect(201)
    const evidence = uploaded.body.evidence
    expect(evidence.exhibitId).toBe('E-001')
    expect(evidence.sha256).toBe(createHash('sha256').update(source).digest('hex'))
    expect(evidence.sourceAvailable).toBe(true)

    const downloaded = await request(app)
      .get(`/api/evidence/${evidence.id}/file`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => callback(null, Buffer.concat(chunks)))
      })
      .expect(200)
    expect(downloaded.body).toEqual(source)
    expect(downloaded.headers['x-content-sha256']).toBe(evidence.sha256)

    await request(app).post(`/api/evidence/${evidence.id}/archive`).expect(200)
    const second = await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach('file', Buffer.from('second'), 'second.txt')
      .expect(201)
    expect(second.body.evidence.exhibitId).toBe('E-002')
    expect(second.body.state.evidence.map((item: { id: string }) => item.id)).not.toContain(
      evidence.id,
    )
    store.close()
  })

  it('preserves invalid PDF sources and exposes extraction failure metadata', async () => {
    const store = new CaseStore(':memory:')
    const app = createApp({ store })
    const created = await request(app).post('/api/matters').send({ title: 'PDF' }).expect(201)
    const uploaded = await request(app)
      .post(`/api/matters/${created.body.activeMatter.id}/evidence`)
      .attach('file', Buffer.from('not a pdf'), 'broken.pdf')
      .expect(201)
    expect(uploaded.body.evidence.sourceAvailable).toBe(true)
    expect(uploaded.body.evidence.ingestionStatus).toBe('extraction_failed')
    expect(uploaded.body.evidence.extractionWarning).toContain('preserved')
    store.close()
  })

  it('round-trips a checksummed matter archive with source, simulation, and TrialForge history', async () => {
    const store = new CaseStore(':memory:')
    const app = createApp({ store })
    const created = await request(app).post('/api/matters').send({ title: 'Portable' }).expect(201)
    const matterId = created.body.activeMatter.id as string
    await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach('file', Buffer.from('portable evidence'), 'portable.txt')
      .expect(201)
    const simulation = store.createSession(matterId)
    store.appendTurn(simulation.id, {
      stage: 'intake_normalization',
      role: 'analyst',
      title: 'Imported turn',
      content: 'Portable content.',
      citations: [],
    })
    const trialForge = new TrialForgeService(store)
    trialForge.create({ matterId, chargeSummary: 'Portable rehearsal' })

    const exported = await request(app)
      .get(`/api/matters/${matterId}/archive`)
      .expect('Content-Type', /json/)
      .expect(200)
    const imported = await request(app)
      .post('/api/matters/import')
      .send(exported.body)
      .expect(201)
    const importedId = imported.body.activeMatter.id as string
    const snapshot = store.exportMatterSnapshot(importedId)
    expect(importedId).not.toBe(matterId)
    expect(snapshot.evidence).toHaveLength(1)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.agentTurns).toHaveLength(1)
    expect(snapshot.trialForgeSessions).toHaveLength(1)
    expect(snapshot.courtroomEvents.length).toBeGreaterThan(0)
    const sourcePath = String(snapshot.evidence[0].source_path)
    expect(await readFile(sourcePath, 'utf8')).toBe('portable evidence')
    store.close()
  })

  it('creates a consistent SQLite backup that can be reopened', async () => {
    const databasePath = join(tempRoot, 'live.sqlite')
    const backupPath = join(tempRoot, 'backup.sqlite')
    const store = new CaseStore(databasePath)
    const matter = store.createMatter({ title: 'Backed up' })
    const pages = await store.backupTo(backupPath)
    expect(pages).toBeGreaterThan(0)
    store.close()
    const backupStore = new CaseStore(backupPath)
    expect(backupStore.getMatter(matter.id).title).toBe('Backed up')
    backupStore.close()
  })

  it('upgrades a legacy database through ordered user_version migrations', () => {
    const path = join(tempRoot, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE matters (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, jurisdiction TEXT NOT NULL,
        narrative TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE evidence (
        id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, exhibit_id TEXT NOT NULL,
        name TEXT NOT NULL, type TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        text TEXT NOT NULL, summary TEXT NOT NULL, tags_json TEXT NOT NULL, uploaded_at TEXT NOT NULL,
        UNIQUE (matter_id, exhibit_id)
      );
      INSERT INTO matters VALUES ('m1', 'Legacy', 'Ontario', '', 'now', 'now');
      INSERT INTO evidence VALUES ('e1', 'm1', 'E-004', 'legacy.txt', 'text', 'text/plain', 1, 'x', 'x', '[]', 'now');
    `)
    legacy.close()
    const upgraded = new CaseStore(path)
    expect(upgraded.getEvidence('e1')).toEqual(
      expect.objectContaining({ sha256: null, sourceAvailable: false, ingestionStatus: 'metadata_only' }),
    )
    upgraded.close()
    const check = new DatabaseSync(path)
    const version = check.prepare('PRAGMA user_version').get() as { user_version: number }
    const counter = check
      .prepare('SELECT next_exhibit_number FROM matter_counters WHERE matter_id = ?')
      .get('m1') as { next_exhibit_number: number }
    expect(version.user_version).toBe(2)
    expect(counter.next_exhibit_number).toBe(5)
    check.close()
  })

  it('labels curated authorities honestly and suppresses live-verification claims', () => {
    for (const authority of listCuratedAuthorities()) {
      expect(authority.provenance).toBe('curated')
      expect(authority.checkedAt).toBeNull()
      expect(authority.note).toContain('not a live citator')
    }
  })

  it('fails closed for remote binding and authenticates every API route', async () => {
    expect(() =>
      assertSafeBindConfiguration({ remote: true, token: null, allowedOrigins: [] }),
    ).toThrow(/LOCAL_API_TOKEN/)
    const security = {
      remote: true,
      token: 'a-secure-token-with-24-characters',
      allowedOrigins: ['https://example.test'],
    }
    const store = new CaseStore(':memory:')
    const app = createApp({ store, security })
    await request(app).get('/api/health').expect(401)
    await request(app)
      .get('/api/health')
      .set('Authorization', `Bearer ${security.token}`)
      .expect(200)
    expect(apiSecurityConfig('127.0.0.1').remote).toBe(false)
    store.close()
  })
})
