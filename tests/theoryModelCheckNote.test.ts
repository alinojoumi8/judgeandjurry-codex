// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { TheoryModelCheckNote } from '../src/components/analysis/analysisShared'
import { mountScreen, unmountScreens } from './screenHarness'

// The Private theories screen shows this note under a theory whose text carries the tags "Use as theory" adds to a sentence the
// model check did not confirm. A saved brief records only that a model wrote it, so the note reads the tags in the text.
afterEach(unmountScreens)

const note = (root: Element) => root.querySelector('[role="note"]')

describe('private theory note about the model check', () => {
  it('says the tagged sentences were not confirmed, for either tag', async () => {
    for (const tag of ['[not confirmed by model check]', '[not checked by model check]']) {
      const root = await mountScreen(TheoryModelCheckNote, { narrative: `Jordan Ellery says the crew leader was the only person on shift. [E-005 para. 1] ${tag}` })
      expect(note(root)!.textContent).toContain('were not confirmed by the model check when the case summary was made')
      expect(note(root)!.textContent).toContain('[not confirmed by model check]')
      expect(note(root)!.textContent).toContain('[not checked by model check]')
    }
  })

  it('shows nothing for a theory without the tags, an empty one, or one that only talks about a check', async () => {
    for (const narrative of ['', 'Plaintiff theory: the walkway was left unsalted.', 'The model check did not confirm this, someone said.']) {
      const root = await mountScreen(TheoryModelCheckNote, { narrative })
      expect(root.innerHTML).toBe('')
    }
  })
})
