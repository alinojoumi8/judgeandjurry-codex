import { describe, expect, it } from 'vitest'

import { improperReason, scanImproper, scanImproperFields } from '../server/analysis/improvementPlanSafety'

// Plan section 4, rule 12: advice stays lawful and honest. The checks are
// deterministic patterns on the text of an instruction, a cure or an idea.
// Every hostile sample is paired with valid controls, so a change to a pattern
// cannot start refusing honest preparation without a test failing. Fictional.

const hostile: Array<[string, string]> = [
  ['fabricate_evidence', 'Fabricate an email from the property manager confirming that the walkway was never salted.'],
  ['fabricate_evidence', 'Forge the signature on the notice of claim so that it appears to have been mailed on time.'],
  ['fabricate_evidence', 'Create a backdated receipt for the physiotherapy sessions that the other clinic never sent.'],
  ['fabricate_evidence', 'Make up a log entry showing the salt truck never arrived.'],
  ['fabricate_evidence', 'Invent a witness who saw the guard shovel the east entrance.'],
  ['fabricate_evidence', 'Plant false evidence in the production so the defendant looks careless.'],
  ['fabricate_evidence', 'Falsify the earnings letter to show higher income.'],
  ['alter_or_destroy_record', 'Alter the incident report so that it says the guard saw salt on the walkway.'],
  ['alter_or_destroy_record', 'Delete the text messages about the phone before production.'],
  ['alter_or_destroy_record', 'Edit the family physician chart quietly so the 2023 knee entry is gone.'],
  ['alter_or_destroy_record', 'Shred the draft notes of the economic report.'],
  ['alter_or_destroy_record', 'Change the metadata timestamps on the photographs so they look like they were taken that morning.'],
  ['false_testimony', 'Have the plaintiff testify falsely that she was wearing winter boots.'],
  ['false_testimony', 'The witness can lie under oath about the phone, nobody will check.'],
  ['false_testimony', 'This is perjury but it will win the case.'],
  ['false_testimony', 'Provide false testimony about the time of the fall.'],
  ['coach_witness', 'Tell the witness what to say about the salt truck, whatever she remembers.'],
  ['coach_witness', 'Coach the witness to say that she saw the salt truck arrive at 05:30, even if she did not.'],
  ['coach_witness', 'Script the witness answers about the phone so they match the plaintiff\'s account.'],
  ['coach_witness', 'Get the witness to change her story about the footwear.'],
  ['coach_witness', 'Coach the witness to say she wore winter boots, even if she did not.'],
  ['coach_witness', 'Help the witness recall that the guard shovelled the entrance.'],
  ['conceal_or_obstruct', 'Conceal the GPS export from the other side until after the trial.'],
  ['conceal_or_obstruct', 'Bribe the clerk to testify that the log was completed on time.'],
  ['conceal_or_obstruct', 'Fail to produce the damaging physiotherapy note in the affidavit of documents.'],
  ['conceal_or_obstruct', 'Intimidate the pharmacy clerk so she withdraws her statement.'],
]

const valid = [
  'Prepare Ms. Ellery to testify truthfully: review her own discovery transcript with her, explain how examination and cross-examination work, and remind her to say when she does not remember.',
  'Walk the witness through the courtroom layout, the oath and the order of questions, and tell her to answer only from her own memory.',
  'Obtain the Winter Services Agreement through the outstanding undertaking.',
  'Send a preservation letter so the camera footage and the GPS data are not overwritten.',
  'Seek an adverse inference because the east entrance footage was overwritten after 30 days.',
  'Move for production of the original service log and its metadata.',
  'Retain an independent economist to re-run the loss figures using the employer\'s earnings letter.',
  'Ask Dr. Castellane to review the 2023 chart and revise her report honestly to deal with the earlier complaint.',
  'Amend the statement of claim to plead the actual date the notice was received.',
  'Do not alter, delete or destroy any record, and keep the metadata as it is.',
  'Make sure no one deletes the emails: they must be preserved for production.',
  'Remind the witness that if her memory differs from the log, she should say so plainly.',
  'Challenge the forged email if the defendant relies on it, using the metadata.',
  'The plaintiff should correct any mistake in her earlier answers by writing to counsel for the defendants.',
  'Ask the doctor to produce the chart and the imaging reports.',
  'Consider a settlement posture that reflects the weakness of the notice evidence.',
  'Obtain <script>alert(1)</script> the log and a copy of the script for the hearing.',
  'Prepare the witness to understand the difference between what she saw and what she heard from others.',
  '',
]

describe('scanImproper: refuses fabricating evidence, altering records, false testimony, coaching and concealment', () => {
  it.each(hostile)('refuses (%s): %s', (code, text) => {
    const matches = scanImproper(text)
    expect(matches.length, text).toBeGreaterThan(0)
    expect(matches.map((match) => match.code), text).toContain(code)
  })

  it.each(valid)('passes honest preparation: %s', (text) => {
    expect(scanImproper(text), text).toEqual([])
  })

  it('does not let a negation cover a later, separate instruction', () => {
    expect(scanImproper('Do not worry about the other side, just alter the log before production.').map((match) => match.code)).toContain('alter_or_destroy_record')
    expect(scanImproper('Never fabricate anything; however, fabricate the receipt.').map((match) => match.code)).toContain('fabricate_evidence')
  })

  it('reports an excerpt and a readable reason for each match', () => {
    const [match] = scanImproper('Fabricate an email from the property manager.')
    expect(match.excerpt.toLowerCase()).toContain('fabricate')
    expect(improperReason(scanImproper('Fabricate an email from the property manager.'))).toMatch(/^Refused: .*inventing or falsifying evidence/)
  })

  it('scans every named field and reports which one matched', () => {
    const found = scanImproperFields({ title: 'Tighten the pleading', description: 'Fabricate a receipt.', riskNote: '' })
    expect(found).toEqual([expect.objectContaining({ field: 'description', code: 'fabricate_evidence' })])
    expect(scanImproperFields({ title: 'Obtain the agreement', description: 'Use the undertaking.' })).toEqual([])
  })
})
