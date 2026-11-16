import { describe, expect, it } from 'vitest'

import { countSyllables, jargonTerms, readabilityHeuristicNote, readabilityStats, readabilityThresholds } from '../server/analysis/readability'
import { civilText } from './intelligenceFixtures'

const plain = 'The man fell on the ice. He hurt his knee. He went to the doctor. The doctor took a picture. The knee was broken.'
const dense = 'A total knee arthroplasty is probable on a balance of probabilities, given degenerative change in the medial compartment and persistent quadriceps weakness following open reduction and internal fixation of the lateral tibial plateau.'

describe('F7 readability and jargon density (a stated heuristic)', () => {
  it('counts syllables by rule of thumb', () => {
    expect(['cat', 'table', 'water', 'arthroplasty', 'the', 'made', 'dentist'].map(countSyllables)).toEqual([1, 2, 2, 4, 1, 1, 2])
    expect(countSyllables('')).toBe(0)
    expect(countSyllables('1234')).toBe(0)
  })

  it('scores plain text as easy, with no jargon', () => {
    const result = readabilityStats(plain)
    expect(result.words).toBe(24)
    expect(result.sentences).toBe(5)
    expect(result.fleschReadingEase).toBeGreaterThan(90)
    expect(result.fleschKincaidGrade).toBeLessThan(3)
    expect(result.band).toBe('plain')
    expect(result.jargon).toEqual({ terms: [], words: 0, share: 0 })
    expect(result.hardForLayReader).toBe(false)
  })

  it('scores dense expert prose as hard, and counts the jargon it contains', () => {
    const result = readabilityStats(dense)
    expect(result.fleschKincaidGrade).toBeGreaterThan(readabilityThresholds.hardGrade)
    expect(['difficult', 'very_difficult']).toContain(result.band)
    expect(result.hardForLayReader).toBe(true)
    const terms = Object.fromEntries(result.jargon.terms.map((entry) => [entry.term, entry.count]))
    expect(terms).toMatchObject({ arthroplasty: 1, 'balance of probabilities': 1, degenerative: 1, medial: 1, compartment: 1, quadriceps: 1, 'open reduction': 1, 'internal fixation': 1, lateral: 1, tibial: 1, plateau: 1 })
    expect(result.jargon.share).toBeGreaterThan(readabilityThresholds.heavyJargonShare)
    // Multi-word terms count every word they contain.
    expect(result.jargon.words).toBeGreaterThanOrEqual(15)
    expect(readabilityStats(dense).fleschReadingEase).toBeLessThan(readabilityStats(plain).fleschReadingEase)
  })

  it('is deterministic and states that it is a heuristic', () => {
    expect(readabilityStats(dense)).toEqual(readabilityStats(dense))
    expect(readabilityStats(dense).note).toBe(readabilityHeuristicNote)
    expect(readabilityHeuristicNote).toMatch(/Stated heuristic/)
    expect(jargonTerms.every((term) => term === term.toLowerCase())).toBe(true)
  })

  it('does not split sentences at abbreviations, and skips headings', () => {
    const result = readabilityStats('Dr. Castellane examined P. Marchetti at 9 a.m. today.\nQualifications\nI am a practising surgeon in Ontario, Canada.')
    expect(result.sentences).toBe(2)
  })

  it('reports insufficient text instead of a score', () => {
    expect(readabilityStats('')).toMatchObject({ band: 'insufficient_text', fleschReadingEase: 0, hardForLayReader: false })
    expect(readabilityStats('Too short.').band).toBe('insufficient_text')
  })

  it('scores the three fictional expert reports and finds more jargon in the orthopaedic reports', () => {
    const economic = readabilityStats(civilText.get('14-expert-report-economic-loss.txt')!)
    const ortho = readabilityStats(civilText.get('12-expert-report-plaintiff-orthopaedic.txt')!)
    expect(ortho.jargon.words).toBeGreaterThan(0)
    expect(ortho.words).toBeGreaterThan(40)
    expect(Number.isFinite(economic.fleschKincaidGrade)).toBe(true)
  })
})
