// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdmissionLedger } from '../src/trialEngineTypes'
import type { EvidenceUse } from '../server/trialEngineTypes'
import type { EvidenceItem } from '../server/types'
import { admissionInputSchema } from '../server/workflowSchemas'
import { validateEvidenceScope } from '../server/evidenceRestrictions'

const componentPath = '../src/components/WorkflowEditors.tsx'
const { AdmissionEditor } = await import(componentPath)
const browserDocument = Reflect.get(globalThis, 'document')
const roots: Array<ReturnType<typeof createRoot>> = []
const source = { id: 'fictional-source', name: 'Fictional notice', text: 'Notice arrived.\n\nUnrelated statement.' } as EvidenceItem
const scope = { paragraphs: [1], issueIds: ['issue-1'], partyIds: ['party-1'], prohibitedPurposes: ['truth'], purpose: 'notice' }
const use = { evidenceId: source.id, status: 'admitted' as const, purposes: ['notice', 'chronology'], redactions: ['private'], hiddenFrom: ['witness'], note: 'Fictional restrictions.', scope }

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function editor(initial: AdmissionLedger['evidenceUses'][number] = use) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  const onSave = vi.fn(async (_uses: AdmissionLedger['evidenceUses'], _reason: string) => {})
  await act(async () => root.render(createElement(AdmissionEditor, {
    sources: [source], busy: false, onSave,
    ledger: { reason: 'Fictional purpose review.', evidenceUses: [initial] },
  })))
  const field = (label: string) => {
    const wrapper = Array.from(element.querySelectorAll('label')).find((item: any) => item.textContent.startsWith(label)) as HTMLLabelElement | undefined
    return wrapper?.querySelector('textarea, select') as HTMLTextAreaElement | HTMLSelectElement | undefined
  }
  const type = async (label: string, value: string) => {
    const target = field(label) as HTMLTextAreaElement
    if (!target) throw new Error(`Missing ${label}`)
    await act(async () => {
      Object.getOwnPropertyDescriptor(Reflect.get(globalThis, 'HTMLTextAreaElement').prototype, 'value')!.set!.call(target, value)
      target.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const save = async () => {
    const button = Array.from(element.querySelectorAll('button')).find((item: any) => item.textContent === 'Save document-use settings') as HTMLButtonElement
    await act(async () => button.click())
    const [uses, reason] = onSave.mock.calls.at(-1)!
    return admissionInputSchema.parse({ evidenceUses: uses, reason }).evidenceUses[0]
  }
  return { element, field, type, save, onSave }
}

function expectPreserved(saved: Pick<EvidenceUse, 'scope' | 'note' | 'redactions' | 'hiddenFrom'>) {
  expect(saved.scope).toMatchObject({ paragraphs: [1], issueIds: ['issue-1'], partyIds: ['party-1'] })
  expect(saved.note).toBe(use.note)
  expect(saved.redactions).toEqual(use.redactions)
  expect(saved.hiddenFrom).toEqual(use.hiddenFrom)
}

describe('proceeding purpose editing', () => {
  it('does not add passage restrictions when editing a source without a scope', async () => {
    const { field, type, save } = await editor({ ...use, scope: undefined })
    await type('Permitted purposes', ' notice received ')
    expect(field('Purpose for this proceeding')?.value).toBe('')
    const saved = await save()
    expect(saved.purposes).toEqual(['notice received'])
    expect(saved.scope).toBeUndefined()
    expect(() => validateEvidenceScope(saved, source, ['issue-1'], ['party-1'])).not.toThrow()
  })

  it.each(['chronology', ''])('clears a removed selection when permitted purposes become %j', async permitted => {
    const { element, field, type, save } = await editor()
    await type('Permitted purposes', permitted)
    expect(field('Purpose for this proceeding')?.value).toBe('')
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('Select the permitted purpose')
    const saved = await save()
    expect(saved.scope?.purpose).toBeUndefined()
    expect(saved.purposes).toEqual(permitted ? ['chronology'] : [])
    expectPreserved(saved)
    expect(() => validateEvidenceScope(saved, source, ['issue-1'], ['party-1'])).not.toThrow()
  })

  it('does not retain a hidden selection after both purpose lists are cleared', async () => {
    const { field, type, save } = await editor()
    await type('Prohibited purposes', '')
    await type('Permitted purposes', '')
    expect(field('Purpose for this proceeding')).toBeUndefined()
    const saved = await save()
    expect(saved.scope?.purpose).toBeUndefined()
    expectPreserved(saved)
    expect(() => validateEvidenceScope(saved, source, ['issue-1'], ['party-1'])).not.toThrow()
  })

  it('clears a newly prohibited selection and keeps the conflicting lists rejected until corrected', async () => {
    const { element, field, type, save } = await editor()
    await type('Prohibited purposes', ' truth \n notice ')
    const select = field('Purpose for this proceeding') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(Array.from(select.options, option => option.value)).toEqual(['', 'chronology'])
    expect(element.querySelector('[role="alert"]')).not.toBeNull()
    const conflict = await save()
    expect(conflict.scope?.purpose).toBeUndefined()
    expectPreserved(conflict)
    expect(() => validateEvidenceScope(conflict, source, ['issue-1'], ['party-1'])).toThrow('A purpose cannot be both permitted and prohibited.')
    await type('Permitted purposes', 'chronology')
    await act(async () => {
      select.value = 'chronology'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const corrected = await save()
    expect(corrected.scope?.purpose).toBe('chronology')
    expectPreserved(corrected)
    expect(() => validateEvidenceScope(corrected, source, ['issue-1'], ['party-1'])).not.toThrow()
  })

  it.each(['Permitted purposes', 'Prohibited purposes'])('retains a valid selection when %s are edited with surrounding whitespace', async label => {
    const { field, type, save } = await editor()
    const text = label === 'Permitted purposes' ? ' notice \n chronology \n context ' : ' truth \n guilt '
    await type(label, text)
    expect(field(label)?.value).toBe(text)
    expect(field('Purpose for this proceeding')?.value).toBe('notice')
    const saved = await save()
    expect(saved.scope?.purpose).toBe('notice')
    expectPreserved(saved)
    expect(() => validateEvidenceScope(saved, source, ['issue-1'], ['party-1'])).not.toThrow()
  })

  it.each(['Permitted purposes', 'Prohibited purposes'])('keeps a trailing space editable while typing multiword %s', async label => {
    const { field, type } = await editor()
    await type(label, 'notice ')
    expect(field(label)?.value).toBe('notice ')
    await type(label, 'notice received')
    expect(field(label)?.value).toBe('notice received')
  })

  it.each(['Permitted purposes', 'Prohibited purposes'])('keeps Enter, second-line typing and trailing blank lines editable in %s', async label => {
    const { field, type, save, onSave } = await editor()
    const first = label === 'Permitted purposes' ? 'notice' : 'truth'
    const second = label === 'Permitted purposes' ? 'chronology' : 'guilt'
    await type(label, first)
    let expected = first
    for (const character of `\n${second}\n\n`) {
      const textarea = field(label) as HTMLTextAreaElement
      const key = character === '\n' ? 'Enter' : character
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await type(label, textarea.value + character)
      textarea.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
      expected += character
      expect(field(label)?.value).toBe(expected)
    }
    const saved = await save()
    const raw = onSave.mock.calls.at(-1)![0][0]
    expect(label === 'Permitted purposes' ? raw.purposes : raw.scope?.prohibitedPurposes).toEqual([first, second])
    expect(saved.scope?.purpose).toBe('notice')
    expectPreserved(saved)
    expect(() => validateEvidenceScope(saved, source, ['issue-1'], ['party-1'])).not.toThrow()
    expect(field(label)?.value).toBe(`${first}\n${second}\n\n`)
  })

  it('preserves server rejection of an unknown saved purpose', async () => {
    const { save } = await editor({ ...use, scope: { ...scope, purpose: 'unlisted' } })
    const saved = await save()
    expect(saved.scope?.purpose).toBe('unlisted')
    expect(() => validateEvidenceScope(saved, source, ['issue-1'], ['party-1'])).toThrow('The selected proceeding purpose must be permitted')
  })
})
