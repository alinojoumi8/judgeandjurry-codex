import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const identity = (name: string) => `AFFIDAVIT OF ${name.toUpperCase()}\nI, ${name}, of the City of Alder MAKE OATH AND SAY:`
const source = (exhibitId: string, name: string, ...paragraphs: string[]) => ({ ...supportedOpeningSource, id: exhibitId, exhibitId, text: [identity(name), ...paragraphs].join('\n\n') })
const quote = 'nothing has been retained'
const sources = [source('E-001', 'River Moss', 'The file was opened.', `To date, ${quote}.`), source('E-002', 'Cedar Vale', `Moss’s statement that “${quote}” requires review.`)]
function check(text: string, evidence = sources, citations = [{ exhibitId: 'E-001', paragraph: 2 }, { exhibitId: 'E-002', paragraph: 2 }], status = 'supported') {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, supportTypes: ['source', 'analysis'], explanation: 'Independently assess the selected accounts and attribution.', citations, recordCitations: [] }] }), [{ id: 'content:1', text }], evidence)
}

describe('quotation premises in local citation groups', () => {
  it.each(['(E-001, para. 3; E-002, para. 2)', '(E-001, paragraph 3; E-002, paragraph 2)', '(E-001, paragraph 3) (E-002, paragraph 2)'])('keeps all local references inside %s', references => {
    expect(check(`Vale argues that Moss’s statement that “${quote}” supports review ${references}.`).status).toBe('passed')
  })
  it('does not let an explicitly named wrong source borrow a second source', () => {
    expect(check(`E-001’s statement that “${quote}” supports review (E-001, paragraph 2; E-002, paragraph 2).`).status).toBe('failed')
  })
  it.each(['; ', '. ', ', while '])('does not borrow a reference across the prose boundary %s', boundary => {
    expect(check(`Moss’s statement that “${quote}” supports review (E-001, paragraph 2)${boundary}E-002 discusses the account.`).status).toBe('failed')
  })
  it('retains a parenthetical exhibit attached to the source introducing a premise', () => {
    const text = 'The report (E-001) confirmed the statement that no cash was returned, while the second report discusses its sources (E-002).'
    const evidence = [source('E-001', 'River Moss', 'The file was opened.'), source('E-002', 'Cedar Vale', 'No cash was returned.')]
    expect(check(text, evidence).status).toBe('failed')
    expect(check(text, [source('E-001', 'River Moss', 'No cash was returned.'), evidence[1]]).status).toBe('passed')
  })
  it('does not borrow an unselected paragraph or an unlisted exhibit', () => {
    expect(check(`Moss’s statement that “${quote}” supports review (E-001, paragraph 2).`, sources, [{ exhibitId: 'E-001', paragraph: 2 }]).status).toBe('failed')
    expect(check(`Moss’s statement that “${quote}” supports review (E-001, paragraph 2).`).status).toBe('failed')
  })
  it('binds the attached exhibit even when an earlier aside names another source', () => {
    const evidence = [source('E-001', 'River Moss', 'A file was opened.'), source('E-002', 'Cedar Vale', 'No cash was returned.')]
    const text = 'For context (compare E-002; unrelated), the statement that no cash was returned (E-001) remains unverified.'
    expect(check(text, evidence).status).toBe('failed')
    expect(check(text.replace('returned (E-001)', 'returned (E-002)'), evidence).status).toBe('passed')
  })
  it('preserves the quoted inner speaker rather than assigning those words to someone else', () => {
    expect(check(`Vale argues that Flint’s statement that “${quote}” supports review (E-001, para. 3; E-002, para. 2).`).status).toBe('failed')
  })
  it('does not accept an altered quotation from a local group', () => {
    expect(check('Vale argues that Moss’s statement that “everything has been retained” supports review (E-001, para. 3; E-002, para. 2).').status).toBe('failed')
  })
})

const denial = 'I did not sign the acknowledgement.'
const admission = 'I signed the acknowledgement.'
const opposing = [source('E-001', 'Rowan Alder', denial), source('E-002', 'Cedar Vale', 'Rowan signed the acknowledgement in my presence.')]
const selectors = [{ exhibitId: 'E-001', paragraph: 2 }, { exhibitId: 'E-002', paragraph: 2 }]
describe('source speaker identity for reported history changes', () => {
  it.each(['changed', 'materially changed', 'has changed', 'significantly shifted', 'substantially reversed'])('does not turn conflicting speakers into an own-account change: %s', change => {
    expect(check(`Alder’s account of the acknowledgement ${change} (E-001, paragraph 2; E-002, paragraph 2).`, opposing, selectors).status).toBe('failed')
  })
  it.each(['supported', 'analysis'])('accepts selected earlier and later accounts of the same speaker under %s', status => {
    const evidence = [opposing[0], source('E-002', 'Rowan Alder', admission)]
    expect(check('Alder’s account of the acknowledgement materially changed (E-001, paragraph 2; E-002, paragraph 2).', evidence, selectors, status).status).toBe('passed')
  })
  it('accepts an explicit correction by the named deponent in one selected passage', () => {
    const correction = 'I incorrectly stated that Rowan did not sign the acknowledgement. In fact, Rowan did sign the acknowledgement in my presence.'
    expect(check('Vale’s account of the acknowledgement materially changed (E-002, paragraph 2).', [source('E-002', 'Cedar Vale', correction)], [{ exhibitId: 'E-002', paragraph: 2 }]).status).toBe('passed')
  })
  it.each([
    ['The record shows Vale', 'passed'],
    ['The selected passages indicate Cedar Vale', 'passed'],
    ['The record shows that Cedar Vale', 'passed'],
    ['The record shows River Vale', 'failed'],
    ['in the second affidavit vale', 'passed'],
    ['According to the earlier statement Cedar Vale', 'passed'],
    ['In that affidavit the record shows Cedar Vale', 'passed'],
    ['In the second affidavit River Vale', 'failed'],
  ])('binds the speaker after an evidentiary reporting phrase in "%s"', (subject, expected) => {
    const correction = 'I incorrectly stated that I did not receive the payment. In fact, I received the payment.'
    const evidence = [source('E-002', 'Cedar Vale', correction)]
    const claim = subject + '’s account of the payment changed (E-002, paragraph 2).'
    expect(check(claim, evidence, [{ exhibitId: 'E-002', paragraph: 2 }]).status).toBe(expected)
  })
  it('cannot use a correction by the other person to establish this person changed their account', () => {
    const correction = 'I incorrectly stated that Rowan did not sign the acknowledgement. In fact, Rowan did sign the acknowledgement in my presence.'
    expect(check('Alder’s account of the acknowledgement materially changed (E-001, paragraph 2; E-002, paragraph 2).', [opposing[0], source('E-002', 'Cedar Vale', correction)], selectors).status).toBe('failed')
  })
  it('does not count two passages from one uncorrected source as earlier and later accounts', () => {
    const evidence = [source('E-001', 'Rowan Alder', 'Vale says I signed the acknowledgement.', denial), opposing[1]]
    expect(check('Alder’s account of the acknowledgement materially changed (E-001, paragraphs 2-3; E-002, paragraph 2).', evidence, [...selectors, { exhibitId: 'E-001', paragraph: 3 }]).status).toBe('failed')
  })
  it('requires selected statements, not a different unselected paragraph', () => {
    expect(check('Alder’s account of the acknowledgement materially changed (E-001, paragraph 2; E-002, paragraph 2).', [opposing[0], source('E-002', 'Rowan Alder', 'The file was opened.', admission)], selectors).status).toBe('failed')
  })
  it.each(['Vale says: “I incorrectly stated that Rowan did not sign the acknowledgement. In fact, Rowan did sign the acknowledgement.”', 'If I incorrectly stated that Rowan did not sign the acknowledgement, I would correct it.'])('rejects quoted or hypothetical self-corrections: %s', correction => {
    expect(check('Alder’s account of the acknowledgement materially changed (E-001, paragraph 2).', [source('E-001', 'Rowan Alder', correction)], [{ exhibitId: 'E-001', paragraph: 2 }]).status).toBe('failed')
  })
  it('preserves the full speaker identity and rejects another person with the same surname', () => {
    const evidence = [opposing[0], source('E-002', 'Rowan Alder', admission)]
    expect(check('Rowan Alder’s account of the acknowledgement changed (E-001, paragraph 2; E-002, paragraph 2).', evidence, selectors).status).toBe('passed')
    expect(check('River Alder’s account of the acknowledgement changed (E-001, paragraph 2; E-002, paragraph 2).', evidence, selectors).status).toBe('failed')
  })
  it('does not label repeated statements in two documents a changed account', () => {
    expect(check('Alder’s account of the acknowledgement changed (E-001, paragraph 2; E-002, paragraph 2).', [opposing[0], source('E-002', 'Rowan Alder', denial)], selectors).status).toBe('failed')
  })
  it('recognizes a unique opening speaker when the selected correction starts at offset zero', () => {
    const correction = 'Cedar Vale states: I incorrectly stated that Rowan did not sign the acknowledgement. In fact, Rowan did sign the acknowledgement in my presence.'
    const exhibit = { ...opposing[1], text: correction }
    const claim = 'Vale’s account of the acknowledgement changed (E-002, paragraph 1).'
    expect(check(claim, [exhibit], [{ exhibitId: 'E-002', paragraph: 1 }]).status).toBe('passed')
    expect(check(claim, [{ ...exhibit, text: correction.replace('Cedar Vale states:', 'Aster Moss states:') }], [{ exhibitId: 'E-002', paragraph: 1 }]).status).toBe('failed')
  })
  it('compares opposing accounts only when both exhibits name the same person', () => {
    const claim = 'Alder’s account of the acknowledgement changed (E-001, paragraph 2; E-002, paragraph 2).'
    expect(check(claim, [opposing[0], source('E-002', 'River Alder', admission)], selectors).status).toBe('failed')
    expect(check(claim, [opposing[0], source('E-002', 'Rowan Alder', admission)], selectors).status).toBe('passed')
  })
  it('accepts a denial of an established change while separately checking an affirmative claim', () => {
    const statement = 'The evidence does not show that Rowan Alder’s account of the acknowledgement changed'
    const selector = [{ exhibitId: 'E-001', paragraph: 2 }]
    expect(check(statement + ' (E-001, paragraph 2).', opposing, selector, 'analysis').status).toBe('passed')
    expect(check(statement.replace('does not show', 'shows') + ' (E-001, paragraph 2).', opposing, selector).status).toBe('failed')
    expect(check(statement + ', but the record shows that Vale’s account of the payment changed (E-001, paragraph 2).', opposing, selector).status).toBe('failed')
  })
  it('recognizes an oath in the selected first paragraph and rejects a quoted or competing identity', () => {
    const oath = 'I, Cedar Vale, make oath and say: '
    const words = 'I incorrectly stated that I did not receive the payment. In fact, I received the payment.'
    const claim = 'Vale’s account of the payment changed (E-002, paragraph 1).'
    const selected = [{ exhibitId: 'E-002', paragraph: 1 }]
    const test = (text: string) => check(claim, [{ ...opposing[1], text }], selected).status
    expect(test(oath + words)).toBe('passed')
    expect(test('Moss quoted a witness: “' + oath + '” ' + words)).toBe('failed')
    expect(test(oath + words + ' I, Aster Moss, make oath and say: I received the payment.')).toBe('failed')
  })
  it('requires the correction to follow the earlier account', () => {
    const correction = 'In fact, Rowan did sign the acknowledgement in my presence. I incorrectly stated that Rowan did not sign the acknowledgement.'
    expect(check('Vale’s account of the acknowledgement changed (E-002, paragraph 2).', [source('E-002', 'Cedar Vale', correction)], [{ exhibitId: 'E-002', paragraph: 2 }]).status).toBe('failed')
  })
  it.each(['Alder’s account changed', 'Alder’s account of the changed'])('requires a stated topic rather than unrelated first-person sentences: %s', claim => {
    const evidence = [source('E-001', 'Rowan Alder', 'I work in Alder.'), source('E-002', 'Rowan Alder', 'I live in Birch.')]
    expect(check(claim + ' (E-001, paragraph 2; E-002, paragraph 2).', evidence, selectors).status).toBe('failed')
  })
  it('requires the draft to name what changed even when the selected exhibits oppose each other', () => {
    const evidence = [opposing[0], source('E-002', 'Rowan Alder', admission)]
    const result = check('Alder’s account changed (E-001, paragraph 2; E-002, paragraph 2).', evidence, selectors)
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toMatch(/name what changed/i)
  })
  it.each(['I did sign the acknowledgement.', 'I signed the acknowledgement later.'])('does not equate changed wording with a changed position: %s', later => {
    expect(check('Alder’s account of the acknowledgement changed (E-001, paragraph 2; E-002, paragraph 2).', [source('E-001', 'Rowan Alder', admission), source('E-002', 'Rowan Alder', later)], selectors).status).toBe('failed')
  })
  it.each(['I did not receive the acknowledgement.', 'I did not sign the acknowledgement before June.'])('preserves the action and timing when comparing polarity: %s', earlier => {
    expect(check('Alder’s account of the acknowledgement changed (E-001, paragraph 2; E-002, paragraph 2).', [source('E-001', 'Rowan Alder', earlier), source('E-002', 'Rowan Alder', admission)], selectors).status).toBe('failed')
  })
  it('accepts an explicit first-person auxiliary with an opposed account', () => {
    expect(check('Alder’s account of the acknowledgement changed (E-001, paragraph 2; E-002, paragraph 2).', [opposing[0], source('E-002', 'Rowan Alder', 'I did sign the acknowledgement.')], selectors).status).toBe('passed')
  })
  it('preserves a hypothetical change rather than treating it as an assertion', () => {
    expect(check('If Alder’s account of the acknowledgement changed, further review would be needed (E-001, paragraph 2).', opposing, selectors, 'analysis').status).toBe('passed')
  })
})

describe('cross-speaker correction through the full client', () => {
  it('repairs the rejected history claim while preserving accepted text', async () => {
    const { MiniMaxClient } = await import('../server/minimax')
    const accepted = 'The accounts conflict (E-001, paragraph 2; E-002, paragraph 2).'
    const rejected = 'Alder’s account of the acknowledgement materially changed (E-001, paragraph 2; E-002, paragraph 2).'
    const replacement = 'Alder and Vale provide conflicting accounts (E-001, paragraph 2; E-002, paragraph 2).'
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', model: 'fixture', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const tool = body.tools?.[0]?.function?.name
      const response = (data: unknown) => Response.json({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: tool, arguments: JSON.stringify(data) } }] }, finish_reason: 'tool_calls' }] })
      if (tool === 'record_grounding_review') {
        const units = JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1])
        return response({ findings: Object.fromEntries(units.map((unit: { id: string }) => [unit.id, { status: unit.id.startsWith('title:') ? 'analysis' : 'supported', supportTypes: [unit.id.startsWith('title:') ? 'analysis' : 'source'], explanation: 'Independent fixture review; local checks must retain attribution failures.', citations: unit.id.startsWith('title:') ? [] : selectors, recordCitations: [] }])) })
      }
      if (tool === 'repair_grounding_units') {
        expect(JSON.stringify(body.messages)).toContain('Printed affidavit paragraph numbers and PDF page labels are different locators')
        return response({ repairs: [{ unitId: 'content:2', replacement }] })
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Review', content: accepted + ' ' + rejected, citations: ['E-001', 'E-002'], jurors: [] }) } }] })
    })
    const result = await client.generateStage({ stage: 'defence_opening', civilMotionHearing: true, packet: '', previousTurns: '', groundingRequired: true, evidence: opposing })
    expect(result.content).toBe(accepted + ' ' + replacement)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures?.[0].findings.find(finding => finding.unitId === 'content:2')?.status).toBe('unsupported')
    expect(bodies).toHaveLength(4)
  })
})
