import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const heading = 'AFFIDAVIT OF CEDAR VALE\nI, Cedar Vale, of the City of Alder MAKE OATH AND SAY:'
const prior = 'At paragraph 17 of my earlier affidavit, I incorrectly stated that Rowan did not sign the Acknowledgement.'
const corrected = 'In fact, Rowan did sign the Acknowledgement in my presence and in the presence of various witnesses.'
const context = 'With respect to the acknowledgement dated June 14, I wish to correct and clarify my affidavit evidence.'
const passage = `${context} ${prior} ${corrected}`
const claim = 'Vale corrected their earlier statement that Rowan did not sign the June 14 acknowledgement and now says Rowan signed it in their presence (E-002, paragraph 2).'
function check(text = claim, selected = passage, identity = heading, status = 'supported', paragraph = 2) {
  const evidence = [
    { ...supportedOpeningSource, exhibitId: 'E-002', text: `${identity}\n\n${selected}` },
    { ...supportedOpeningSource, id: 'other', exhibitId: 'E-003', text: `${heading}\n\n${passage}` },
  ]
  return parseGroundingReview(JSON.stringify({ findings: [{
    unitId: 'content:1', status, supportTypes: ['source'], explanation: 'The source records an attributed correction; the event remains disputed.',
    citations: [{ exhibitId: 'E-002', paragraph }], recordCitations: [],
  }] }), [{ id: 'content:1', text }], evidence)
}

describe('attributed correction history in selected passages', () => {
  it.each(['supported', 'analysis'])('accepts the ordered report without establishing its truth under %s', status => {
    expect(check(claim, passage, heading, status).status).toBe('passed')
  })
  it('accepts an exact object and an explicitly named source speaker', () => {
    const text = 'Vale corrected their earlier statement that Rowan did not sign the acknowledgement and now says Rowan signed the acknowledgement in their presence (E-002, paragraph 2).'
    expect(check(text).status).toBe('passed')
  })
  it('accepts the full deponent name and spelling variant', () => {
    expect(check(claim.replace('Vale corrected', 'Cedar Vale corrected').replaceAll('acknowledgement', 'acknowledgment')).status).toBe('passed')
  })
  it('accepts the same constrained report in a named account', () => {
    expect(check(claim, passage, 'Cedar Vale states:').status).toBe('passed')
  })
  it.each([
    ['wrong speaker', claim.replace('Vale corrected', 'Moss corrected'), passage, heading],
    ['wrong source speaker', claim, passage, heading.replaceAll('Cedar Vale', 'Aster Moss').replace('CEDAR VALE', 'ASTER MOSS')],
    ['unknown speaker', claim, passage, 'Unattributed excerpt'],
    ['missing earlier account', claim, `${context} ${corrected}`, heading],
    ['missing correction', claim, `${context} ${prior}`, heading],
    ['reversed source history', claim, `${context} ${corrected} ${prior}`, heading],
    ['invented old polarity', claim.replace('did not sign', 'signed'), passage, heading],
    ['invented new polarity', claim.replace('Rowan signed it', 'Rowan did not sign it'), passage, heading],
    ['different corrected actor', claim.replace('now says Rowan', 'now says Morgan'), passage, heading],
    ['different object', claim.replaceAll('acknowledgement', 'agreement'), passage, heading],
    ['different date', claim.replace('June 14', 'June 15'), passage, heading],
    ['unsupported qualifier', claim.replace('in their presence', 'in their presence before noon'), passage, heading],
    ['conditional correction', claim, passage.replace('In fact,', 'If confirmed,'), heading],
    ['discredited correction', claim, passage.replace('In fact,', 'The false assertion is that'), heading],
    ['quoted other speaker', claim, `${context} Moss says: "${prior} ${corrected}"`, heading],
    ['hypothetical old report', claim, passage.replace('I incorrectly stated', 'If I incorrectly stated'), heading],
    ['qualified source correction', claim, passage.replace('in my presence and in the presence of various witnesses', 'in my presence only after noon'), heading],
  ])('rejects %s even if a complete checker calls it supported', (_label, text, selected, identity) => {
    expect(check(text, selected, identity).status).toBe('failed')
  })
  it('does not borrow the unselected paragraph or another exhibit', () => {
    expect(check(claim, `${context}\n\n${prior} ${corrected}`).status).toBe('failed')
    expect(check(claim.replace('E-002', 'E-003')).status).toBe('failed')
  })
  it('does not accept another unsupported premise in the same finding', () => {
    expect(check(claim + ' Its statement that all records were destroyed supports inquiry (E-002, paragraph 2).').status).toBe('failed')
  })

  it('binds a shortened document date despite an intervening affidavit date', () => {
    const selected = passage.replace('dated June 14', 'dated June 14, 2024').replace('my earlier affidavit', 'my May 29 affidavit')
    expect(check(claim, selected).status).toBe('passed')
    expect(check(claim.replace('June 14', 'June 14, 2025'), selected).status).toBe('failed')
  })
  it('uses the nearest corrected-document date, not a different earlier document', () => {
    expect(check(claim, 'The acknowledgement dated June 14 was attached. ' + passage.replace('dated June 14', 'dated June 15')).status).toBe('failed')
  })
  it('supports another regular verb without changing either account', () => {
    const text = claim.replace('sign', 'return').replace('signed', 'returned').replaceAll('acknowledgement', 'letter')
    const selected = passage.replaceAll('sign', 'return').replaceAll('Acknowledgement', 'letter').replaceAll('acknowledgement', 'letter')
    expect(check(text, selected).status).toBe('passed')
  })
  it.each(['"', '“'])('does not adopt a multi-sentence quotation by someone else (%s)', open => {
    const close = open === '“' ? '”' : open
    expect(check(claim, context + ' Moss says: ' + open + 'My account follows. ' + prior + ' ' + corrected + close).status).toBe('failed')
  })
  it('does not turn the corrected allegation into proof of authenticity', () => {
    expect(check(claim + ' Its confirmation that the acknowledgement is authentic establishes authenticity (E-002, paragraph 2).').status).toBe('failed')
  })
  it('cannot use the identity paragraph as factual support', () => {
    expect(check(claim, passage, heading, 'supported', 1).status).toBe('failed')
  })

  it('does not override a model rejection of the same correction', () => {
    expect(check(claim, passage, heading, 'unsupported').status).toBe('failed')
  })
  it('does not treat the discredited earlier account as current support', () => {
    expect(check('Its statement that Rowan did not sign the acknowledgement supports a finding of non-signature (E-002, paragraph 2).').status).toBe('failed')
  })
})

