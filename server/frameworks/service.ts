import { z } from 'zod'

import { canonicalJson } from '../analysis/hash'
import type { CaseStore } from '../db'
import { nowIso } from '../time'
import type { ProcedureAdapterId } from '../trialEngineTypes'
import { frameworkOverrideInputSchema, type FrameworkHistoryEntry, type FrameworkOverride, type JuryFramework, type MatterFrameworkView, type PackSummary, type PackView } from './framework'
import { rulePackHash } from './hash'
import { getRulePack, listRulePacks, rulePacks } from './packs'
import { applyOverrides, describePack, resolveFrameworkWithPack, summarisePack, unreviewedNotice } from './resolver'
import { assertNotBlocked } from './schema'

export const frameworkSelectionInputSchema = z.object({
  packId: z.string().trim().min(1).max(200),
  // The local application has no sign-in, so the person making the change
  // says who they are. It is recorded with every override.
  changedBy: z.string().trim().min(1).max(200),
  overrides: z.array(frameworkOverrideInputSchema).max(20).default([]),
}).strict().superRefine((input, context) => {
  const fields = input.overrides.map((override) => override.field)
  if (new Set(fields).size !== fields.length) context.addIssue({ code: 'custom', message: 'Each rule can be overridden once.' })
})
export type FrameworkSelectionInput = z.infer<typeof frameworkSelectionInputSchema>
export type { MatterFrameworkView } from './framework'

const civilNeeds = ['juryAvailability', 'panelSize', 'decisionRule'] as const

export class FrameworkService {
  private readonly store: CaseStore

  constructor(store: CaseStore) {
    this.store = store
  }

  list(): PackSummary[] {
    const attestations = this.store.frameworks.listAttestations()
    return listRulePacks().map((pack) => summarisePack(describePack(pack, attestations)))
  }

  getPack(packId: string): PackView {
    return describePack(getRulePack(packId), this.store.frameworks.listAttestations())
  }

  getForMatter(matterId: string): MatterFrameworkView {
    this.store.getMatter(matterId)
    const packs = this.list()
    const selection = this.store.frameworks.getSelection(matterId)
    if (!selection) return { matterId, selected: false, unreviewed: true, reviewNotice: unreviewedNotice, packs }
    const attestations = this.store.frameworks.listAttestations()
    const { framework, pack } = resolveFrameworkWithPack({ id: matterId }, selection.packId, selection.overrides, { attestations })
    const view = describePack(pack, attestations)
    return {
      matterId, selected: true, unreviewed: view.unreviewed, reviewNotice: view.reviewNotice,
      selection: { packId: selection.packId, packHash: selection.packHash, overrides: selection.overrides, history: selection.history, updatedAt: selection.updatedAt },
      pack: view, framework, packChangedSinceSaved: view.packHash !== selection.packHash, packs,
    }
  }

  setForMatter(matterId: string, input: FrameworkSelectionInput): MatterFrameworkView {
    this.store.getMatter(matterId)
    if (!rulePacks.has(input.packId)) throw new Error(`Court rules not found: ${input.packId}`)
    const previous = this.store.frameworks.getSelection(matterId)
    const changedAt = nowIso()
    const key = (override: Omit<FrameworkOverride, 'changedBy' | 'changedAt'>) => canonicalJson({
      field: override.field, status: override.status, value: override.value ?? null, reason: override.reason ?? null, authorities: override.authorities ?? [],
    })
    // Switching pack discards the old overrides: they were written for another pack.
    const previousOverrides = previous && previous.packId === input.packId ? previous.overrides : []
    const history: FrameworkHistoryEntry[] = [...(previous?.history ?? [])]
    if (!previous || previous.packId !== input.packId) {
      // Record each override this switch discards, so the history shows why it no longer applies.
      for (const old of previous?.overrides ?? []) {
        history.push({ at: changedAt, by: input.changedBy, kind: 'override_cleared', field: old.field, summary: `Removed the override of ${old.field} because the court rules changed to ${input.packId}.` })
      }
      history.push({ at: changedAt, by: input.changedBy, kind: 'pack_selected', summary: `Chose court rules ${input.packId}.` })
    }
    const overrides: FrameworkOverride[] = input.overrides.map((override) => {
      const same = previousOverrides.find((item) => item.field === override.field && key(item) === key(override))
      if (same) return same
      history.push({ at: changedAt, by: input.changedBy, kind: 'override_set', field: override.field, summary: `Set ${override.field} to ${override.status}${override.reason ? `: ${override.reason}` : ''}.` })
      return { ...override, changedBy: input.changedBy, changedAt }
    })
    for (const old of previousOverrides) {
      if (!overrides.some((item) => item.field === old.field)) {
        history.push({ at: changedAt, by: input.changedBy, kind: 'override_cleared', field: old.field, summary: `Removed the override of ${old.field}.` })
      }
    }
    // Throws a readable error when an override is not a valid value.
    const { pack } = applyOverrides(getRulePack(input.packId), overrides)
    this.store.frameworks.saveSelection({ matterId, packId: input.packId, packHash: rulePackHash(pack), overrides, history })
    return this.getForMatter(matterId)
  }

  // Called when a run is created. A matter with no chosen rules, or a run that
  // is not a civil jury run, pins nothing and behaves as it always has.
  pinForRun(matterId: string, config: { procedureAdapter: ProcedureAdapterId; civilDecisionMaker?: 'judge_alone' | 'jury' }): JuryFramework | undefined {
    if (config.procedureAdapter !== 'ontario_civil_v1') return undefined
    const selection = this.store.frameworks.getSelection(matterId)
    if (!selection) return undefined
    const attestations = this.store.frameworks.listAttestations()
    const { framework, pack } = resolveFrameworkWithPack({ id: matterId }, selection.packId, selection.overrides, { attestations })
    if (config.civilDecisionMaker !== 'judge_alone') {
      assertNotBlocked(pack, civilNeeds, 'A civil jury run')
      if (framework.juryAvailable === false) throw new Error(`The court rules "${pack.id}" say a jury is not available here, so a jury run cannot start. Choose judge alone.`)
    }
    return framework
  }
}
