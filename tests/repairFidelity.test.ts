import { describe, expect, it } from 'vitest'
import { parseGroundingReview, groundingRepairInstructions } from '../server/grounding'
import { applyGroundingPatch, groundingRepairDrift } from '../server/groundingRepair'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingReview } from '../server/grounding'

const heading = 'AFFIDAVIT OF CEDAR VALE\nI, Cedar Vale, of the City of Alder MAKE OATH AND SAY:'
const argument = 'Second, Moss’s statement that “nothing has been preserved” necessarily requires that the restraint end. Assets must exist within the Province of Alder. However, since I do not have any such assets, continuing with the temporary restraint is futile and an abuse of process.'
const property = 'I do not own any property in Alder.'
const nested = 'Vale asserts that Moss’s statement that nothing has been preserved “necessarily requires that the restraint end” and argues that the restraint is futile because Vale owns no Alder property (E-002, paragraphs 2-3).'
function check(text = nested, passage = argument, second = property, speaker = heading, ids = [2, 3]) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported',
    supportTypes: ['source'], explanation: 'Faithful attribution, not adoption of truth.',
    citations: ids.map(paragraph => ({ exhibitId: 'E-002', paragraph })), recordCitations: [],
  }] }), [{ id: 'content:1', text }], [{ ...supportedOpeningSource, exhibitId: 'E-002', text: [speaker, passage, second].join('\n\n') }])
}
describe('nested source arguments', () => {
  it('separates the inner statement from the outer argument with selected support for both', () => {
    expect(check().status).toBe('passed')
  })
  it('recognizes a deponent introduction with a stated corporate capacity and punctuation', () => {
    const identity = heading.replace('of the City of Alder', 'of the City of Alder, acting personally and as director of Alder Ltd., with authority described in this affidavit and in a representative capacity on behalf of the named company in this action')
    expect(check(nested, argument, property, identity).status).toBe('passed')
  })
  it.each([
    ['wrong outer speaker', nested.replace('Vale asserts', 'Flint asserts'), argument, property, heading],
    ['wrong inner speaker', nested.replace('Moss’s', 'Flint’s'), argument, property, heading],
    ['wrong source identity', nested, argument, property, heading.replaceAll('Cedar Vale', 'River Flint')],
    ['changed quoted conclusion', nested.replace('restraint end', 'restraint expand'), argument, property, heading],
    ['changed inner assertion', nested.replace('nothing has been preserved', 'everything has been preserved'), argument, property, heading],
    ['coordinated qualifier', nested, argument.replace('that the restraint end.', 'that the restraint end, and only after trial.'), property, heading],
    ['qualified reported argument', nested, argument.replace('that the restraint end.', 'that the restraint end only after trial.'), property, heading],
    ['different rationale', nested.replace('is futile', 'is justified'), argument, property, heading],
    ['wrong cause speaker', nested.replace('because Vale', 'because Moss'), argument, property, heading],
    ['wrong jurisdiction', nested.replace('no Alder property', 'no Birch property'), argument, property, heading],
    ['conditional ownership', nested, argument, 'If I do not own any property in Alder, the claim changes.', heading],
    ['qualified ownership', nested, argument, 'I do not own any property in Alder before June.', heading],
    ['quoted ownership', nested, argument, 'Moss says: "I do not own any property in Alder."', heading],
    ['discredited cause', nested, argument.replace('However, since', 'It is false that since'), property, heading],
    ['positive source ownership', nested, argument, 'I own property in Alder.', heading],
    ['no causal support', nested, argument.replace('since I do not have any such assets', 'although I have assets'), property, heading],
    ['discredited quoted premise', nested, argument.replace('Second,', 'This false assertion is:'), property, heading],
  ])('rejects %s', (_label, text, source, ownership, identity) => expect(check(text, source, ownership, identity).status).toBe('failed'))
  it.each([
    ['I argue that the balance remains unresolved.', 'passed'],
    ['I argue that the balance remains unresolved, and only after trial.', 'failed'],
    ['I argue that the balance remains unresolved only after trial.', 'failed'],
    ['It is false that I argue that the balance remains unresolved.', 'failed'],
    ['It is not true that I argue that the balance remains unresolved.', 'failed'],
    ['If I argue that the balance remains unresolved, the issue changes.', 'failed'],
    ['Moss says: "I argue that the balance remains unresolved."', 'failed'],
    ['Moss says: "An earlier account. I argue that the balance remains unresolved. Another sentence."', 'failed'],
  ])('checks an explicit argument without adopting quoted or qualified words: %s', (second, expected) => {
    expect(check(nested.replace('the restraint is futile because Vale owns no Alder property', 'the balance remains unresolved'), argument, second).status).toBe(expected)
  })
  it('checks a hyphenated subject without treating it as malformed checker JSON', () => {
    expect(check(nested.replaceAll('the restraint is', 'the short-term restraint is'), argument.replace('the temporary restraint is', 'the short-term restraint is')).status).toBe('passed')
    expect(check(nested.replaceAll('the restraint is', 'the short-term restraint is'), argument.replace('the temporary restraint is', 'the long-term restraint is')).status).toBe('failed')
  })
  it('requires both selected paragraphs rather than borrowing the body', () => expect(check(nested, argument, property, heading, [2]).status).toBe('failed'))
  it('keeps other unsupported premises in the same finding rejected', () => expect(check(nested + ' Its confirmation that all records were burned supports the argument (E-002).').status).toBe('failed'))
})

describe('repair fidelity and source wording', () => {
  const draft = { title: 'Review', content: 'The account contains $840.', citations: ['E-002'], jurors: [] }
  const review = (): GroundingReview => ({ status: 'failed', method: 'source-quotes-and-model-review', repairs: 0,
    errors: ['content:1: amount absent from selected quotation.'], validationErrors: ['content:1: amount absent.'],
    findings: [{ unitId: 'content:1', text: draft.content, status: 'supported', explanation: 'Old checker judgment.',
      citations: [{ exhibitId: 'E-002', paragraph: 1, quote: 'The account contains $420.', startOffset: 0, endOffset: 26 }] }],
  })
  it.each(['The account contains $840.', '  The account contains   $840.  '])('rejects a no-op patch atomically: %s', replacement => {
    expect(() => applyGroundingPatch(draft, review(), { repairs: [{ unitId: 'content:1', replacement }] })).toThrow('unchanged')
    expect(draft.content).toBe('The account contains $840.')
  })
  it('also rejects unchanged legacy full-result repairs', () => {
    expect(groundingRepairDrift(draft, structuredClone(draft), review()).join(' ')).toContain('unchanged')
  })
  it('permits explicit deletion and exposes validation-only failures with their passages', () => {
    expect(applyGroundingPatch(draft, review(), { repairs: [{ unitId: 'content:1', replacement: '' }] }).result.content).toBe('')
    expect(groundingRepairInstructions(review())).toContain('Rejected unit content:1:')
    expect(groundingRepairInstructions(review())).toContain('The account contains $420.')
  })
  it('makes a failed amount unsupported even when the model says supported', () => {
    const result = check('The account contains $840 (E-002, paragraph 2).', 'The account contains $420.', property, heading, [2])
    expect(result.status).toBe('failed')
    expect(result.findings[0].status).toBe('unsupported')
    expect(result.findings[0].explanation).toContain('dollar amount')
  })
  it('keeps source-supported amounts usable', () => {
    expect(check('The account contains $420 (E-002, paragraph 2).', 'The account contains $420.', property, heading, [2]).status).toBe('passed')
  })
  it('preserves the no-inferred-pronoun rule while allowing supplied names', () => {
    const source = 'I live with my parents. I do not own any property in Alder.'
    expect(check('Vale states that he lives with his parents (E-002, paragraph 2).', source, property, heading, [2]).status).toBe('failed')
    expect(check('Vale describes living with parents (E-002, paragraph 2).', source, property, heading, [2]).status).toBe('passed')
  })
})

describe('effective amount repair through the full client', () => {
  it('keeps accepted wording and removes an unsupported amount before fresh verification', async () => {
    const { MiniMaxClient } = await import('../server/minimax')
    const accepted = 'Vale describes living with parents (E-002).'
    const bad = 'The account contains $840 (E-002).'
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const prompt = body.messages[1].content as string
      if (prompt.startsWith('Stage: factual_verification')) {
        const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as Array<{id:string;text:string}>
        return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(unit => ({
          unitId: unit.id, status: unit.id === 'title:1' ? 'analysis' : 'supported',
          supportTypes: unit.id === 'title:1' ? ['analysis'] : ['source'], explanation: 'Independent fixture review of selected passages.',
          citations: unit.id === 'title:1' ? [] : [{ exhibitId: 'E-002', paragraph: 1 }], recordCitations: [],
        })) }) } }] })
      }
      if (bodies.length === 3) {
        expect(prompt).toContain('Rejected unit content:2:')
        expect(prompt).toContain('The account contains $420.')
        return Response.json({ choices: [{ message: { content: JSON.stringify({ repairs: [{ unitId: 'content:2', replacement: '' }] }) } }] })
      }
      expect(prompt).toContain('in unquoted paraphrases repeat the supplied person')
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Review', content: accepted + ' ' + bad, citations: ['E-002'], jurors: [] }) } }] })
    })
    const result = await client.generateStage({ stage: 'defence_opening', civilMotionHearing: true, packet: '', previousTurns: '', groundingRequired: true,
      evidence: [{ ...supportedOpeningSource, exhibitId: 'E-002', text: 'I live with my parents. The account contains $420.' }] })
    expect(result.content).toBe(accepted)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures?.[0].findings.find(f => f.unitId === 'content:2')?.status).toBe('unsupported')
    expect(bodies).toHaveLength(4)
  })
})
