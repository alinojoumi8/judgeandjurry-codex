import { afterEach, describe, expect, it } from 'vitest'

import { CaseWorkflowService } from '../server/caseWorkflow'
import { addSource, cleanupAnalysisFixtures, memoryStore } from './analysisFixtures'
import { civilText } from './intelligenceFixtures'

afterEach(cleanupAnalysisFixtures)

// Plan section 12, item 10: the expert-foundation flag treated the letters "CV"
// inside an Ontario court file number (CV-23-00012345-0000) as a stated
// curriculum vitae, so a report that showed its file number was never flagged.
function flagged(name: string, text: string): string[] {
  const store = memoryStore()
  const matter = store.createMatter({ title: 'Flag fixture', narrative: 'Fictional.' })
  const item = addSource(store, matter.id, name, text)
  return new CaseWorkflowService(store).analyzeDisclosure(matter.id)
    .filter((finding) => finding.category === 'expert_foundation' && finding.sourceRefs.some((ref) => ref.evidenceId === item.id))
    .map((finding) => finding.title)
}

describe('expert foundation flag (replaces the CV keyword check)', () => {
  const economic = civilText.get('14-expert-report-economic-loss.txt')!
  const withFileNumber = (text: string, number: string) => text.replace('\n', `\nCourt file number ${number}.\n`)

  it('flags the fixture report that states no qualifications (planted weakness)', () => {
    expect(flagged('14-expert-report-economic-loss.txt', economic)).toHaveLength(1)
  })

  it('still flags that report when it shows an Ontario court file number (the bug)', () => {
    for (const number of ['CV-23-00012345-0000', 'CV-25-00000-FICT', 'CV 23 00012345 0000']) {
      expect(flagged('report.txt', withFileNumber(economic, number)), number).toHaveLength(1)
    }
  })

  it('does not flag reports that state their qualifications (valid controls)', () => {
    expect(flagged('12-expert-report-plaintiff-orthopaedic.txt', civilText.get('12-expert-report-plaintiff-orthopaedic.txt')!)).toEqual([])
    expect(flagged('13-expert-report-defence-orthopaedic.txt', civilText.get('13-expert-report-defence-orthopaedic.txt')!)).toEqual([])
    expect(flagged('cv.txt', withFileNumber(economic, 'CV-23-00012345-0000').replace('Assumptions', 'My CV is attached.\nAssumptions'))).toEqual([])
    expect(flagged('vitae.txt', `${economic}\nA curriculum vitae is attached.`)).toEqual([])
    expect(flagged('quals.txt', `${economic}\nQualifications: Chartered Business Valuator.`)).toEqual([])
  })

  it('does not flag a document that is not an expert report', () => {
    expect(flagged('claim.txt', civilText.get('01-statement-of-claim.txt')!)).toEqual([])
  })
})
