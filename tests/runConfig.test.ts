import { describe, expect, it } from 'vitest'

import {
  assertRunConfigAllowed,
  inferTemplateId,
  normalizeRunConfig,
  panelDecisionFor,
  panelRulesFor,
  providerStatusFromConfig,
} from '../server/runConfig'
import type { ProviderStatus } from '../server/types'

describe('run configuration', () => {
  it('normalizes unsafe or missing values into bounded defaults', () => {
    const config = normalizeRunConfig({
      providerMode: 'external',
      templateId: 'osc_securities',
      jurorCount: 99,
      stages: ['judge_ruling', 'not_real', 'judge_ruling'],
      retrievalDepth: -4,
    })

    expect(config).toMatchObject({
      providerMode: 'external',
      templateId: 'osc_securities',
      jurorCount: 12,
      stages: ['judge_ruling'],
      retrievalDepth: 1,
      externalDisclosureConfirmed: false,
    })
  })

  it('normalizes removed mock mode to the configured default', () => {
    const config = normalizeRunConfig(
      {
        providerMode: 'mock',
      },
      {
        defaultProviderMode: 'local',
      },
    )

    expect(config.providerMode).toBe('local')
  })

  it('infers OSC and criminal templates from matter language', () => {
    expect(
      inferTemplateId({
        title: 'OSC Smart Prime disclosure',
        narrative: 'Investor trading and MT4 platform records.',
      }),
    ).toBe('osc_securities')
    expect(
      inferTemplateId({
        title: 'Charge screening memo',
        narrative: 'Crown allegations and reasonable doubt.',
      }),
    ).toBe('criminal_defence')
  })

  it('classifies provider mode without exposing secrets', () => {
    const local = providerStatusFromConfig({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen',
      timeoutMs: 1000,
      maxRetries: 0,
    })

    expect(local.mode).toBe('local')
    expect(local.availableModes).toEqual(['local'])

    const external = providerStatusFromConfig({
      provider: 'minimax',
      apiKey: 'secret',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M3',
      timeoutMs: 1000,
      maxRetries: 0,
    })

    expect(external.mode).toBe('external')
    expect(external.hasKey).toBe(true)
    expect(external.availableModes).toEqual(['external'])
  })

  it('marks an external provider without an API key as unavailable', () => {
    const external = providerStatusFromConfig({
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M3',
      timeoutMs: 1000,
      maxRetries: 0,
    })

    expect(external.mode).toBe('external')
    expect(external.hasKey).toBe(false)
    expect(external.availableModes).toEqual([])
  })

  it('defaults panel sizes to the real forum for each template', () => {
    expect(normalizeRunConfig({ templateId: 'criminal_defence' }).jurorCount).toBe(12)
    expect(normalizeRunConfig({ templateId: 'civil_dispute' }).jurorCount).toBe(6)
    expect(normalizeRunConfig({ templateId: 'osc_securities' }).jurorCount).toBe(3)
    expect(
      normalizeRunConfig({ templateId: 'criminal_defence', jurorCount: 6 }).jurorCount,
    ).toBe(6)
  })

  it('defaults deliberation to independent secret ballots', () => {
    expect(normalizeRunConfig({}).deliberationMode).toBe('independent')
    expect(normalizeRunConfig({ deliberationMode: 'grouped' }).deliberationMode).toBe(
      'grouped',
    )
    expect(normalizeRunConfig({ deliberationMode: 'weird' }).deliberationMode).toBe(
      'independent',
    )
  })

  it('applies the real decision rule for each forum', () => {
    expect(panelRulesFor('criminal_defence', 12).requiredVotes).toBe(12)
    expect(panelRulesFor('civil_dispute', 6).requiredVotes).toBe(5)
    expect(panelRulesFor('osc_securities', 3).requiredVotes).toBe(2)

    const hungCriminal = panelDecisionFor(
      'criminal_defence',
      12,
      [
        ...Array.from({ length: 11 }, () => ({ leaning: 'crown' as const })),
        { leaning: 'defence' as const },
      ],
    )
    expect(hungCriminal.reached).toBe(false)
    expect(hungCriminal.leadingSide).toBe('crown')

    const civilMajority = panelDecisionFor(
      'civil_dispute',
      6,
      [
        ...Array.from({ length: 5 }, () => ({ leaning: 'defence' as const })),
        { leaning: 'crown' as const },
      ],
    )
    expect(civilMajority.reached).toBe(true)
    expect(civilMajority.leadingSide).toBe('defence')

    const undecidedPanel = panelDecisionFor('civil_dispute', 6, [
      { leaning: 'mixed' as const },
      { leaning: 'mixed' as const },
      { leaning: 'mixed' as const },
    ])
    expect(undecidedPanel.reached).toBe(false)
    expect(undecidedPanel.leadingSide).toBe('none')
    expect(undecidedPanel.undecided).toBe(3)
  })

  it('requires explicit disclosure confirmation for external runs', () => {
    const provider: ProviderStatus = {
      mode: 'external',
      name: 'minimax',
      label: 'External MiniMax provider',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimax.io/v1',
      hasKey: true,
      disclosureRequired: true,
      availableModes: ['external'],
    }

    expect(() =>
      assertRunConfigAllowed(
        normalizeRunConfig({
          providerMode: 'external',
          externalDisclosureConfirmed: false,
        }),
        provider,
      ),
    ).toThrow(/confirmation/)

    expect(() =>
      assertRunConfigAllowed(
        normalizeRunConfig({
          providerMode: 'external',
          externalDisclosureConfirmed: true,
        }),
        provider,
      ),
    ).not.toThrow()
  })
})
