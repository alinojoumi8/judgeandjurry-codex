import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string) => JSON.parse(readFileSync(`docs/qa/jury/${name}`, 'utf8'))

describe('fictional capture metadata', () => {
  it('keeps the fictional E-002 size aligned with its supplied source text', () => {
    const item = read('v36-captured-entailed-self-departure-false-rejection.json').request.evidence.find((item: { exhibitId: string }) => item.exhibitId === 'E-002')
    expect(item.size).toBe(Buffer.byteLength(item.text, 'utf8'))
  })
  it('uses portable capture pointers without claiming the ignored artifacts are published', () => {
    for (const name of readdirSync('docs/qa/jury').filter(name => name.endsWith('checker-raw.json'))) {
      const capture = read(name)
      for (const field of ['requestFile', 'responseFile']) {
        if (typeof capture[field] !== 'string') continue
        expect(capture[field], `${name}:${field}`).not.toMatch(/[A-Za-z]:|\\/)
        expect(capture[field], `${name}:${field}`).toMatch(/^tmp\/qa\//)
      }
    }
  })
  it('preserves the captured v188 checker bytes and original response hash when correcting explanatory metadata', () => {
    const capture = read('v188-captured-profile-denial.json')
    expect(createHash('sha256').update(capture.checkerContent).digest('hex')).toBe('bd76a39837726ffe3aa7dd496a8bf12d8262f83e21e91cccdc44ccac8a174534')
    expect(capture.responseHash).toBe('8081ced01a89e3ba704fdf9d295ec94b36a1c211316d7b068fc4d9639e006965')
  })
})
