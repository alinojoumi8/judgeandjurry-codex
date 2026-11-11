import type { JurisdictionRulePack, Rule, RuleAuthority } from '../schema'

// Seed pack: Ontario civil jury trials.
//
// What was checked on 2026-11-08: the wording of Courts of Justice Act s. 108
// and s. 118 and of Negligence Act s. 3 was read through an unofficial text
// service (current to 2025-12-11) and must still be compared with e-Laws. The
// five case citations exist and their names match. No case PROPOSITION was
// verified: every rule that rests on a case says "reviewer to confirm" and is
// flagged toBeConfirmed. No attestation ships with this pack: it is unreviewed
// until a named lawyer attests to its exact hash (decision D7).
//
// Nothing here is a figure the reviewer has not supplied: the non-pecuniary
// limit, the punitive standard, interest, collateral benefits and the order of
// damages calculations are unknown.

const asOf = '2026-11-08'

const cja = 'https://canlii.ca/t/9m'
const cjaSection = (section: string): RuleAuthority['url'] => `${cja}#sec${section}`

const statute = (pinpoint: string, section: string): RuleAuthority => ({
  title: 'Courts of Justice Act, R.S.O. 1990, c. C.43', url: cjaSection(section), pinpoint,
})

const negligenceAct: RuleAuthority = {
  title: 'Negligence Act, R.S.O. 1990, c. N.1', url: 'https://canlii.ca/t/2kd#sec3', pinpoint: 's. 3',
}

const caseAuthority = (title: string, url: string, pinpoint: string): RuleAuthority => ({ title, url, pinpoint })

const andrews = caseAuthority('Andrews v. Grand & Toy Alberta Ltd., [1978] 2 SCR 229', 'https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2587/index.do', 'non-pecuniary damages limit (paragraphs to be supplied by the reviewer)')
const terNeuzen = caseAuthority('ter Neuzen v. Korn, [1995] 3 SCR 674', 'https://canlii.ca/t/1frhk', 'non-pecuniary damages limit and juries (paragraphs to be supplied by the reviewer)')
const whiten = caseAuthority('Whiten v. Pilot Insurance Co., 2002 SCC 18', 'https://canlii.ca/t/51vn', 'punitive damages (paragraphs to be supplied by the reviewer)')
const mohan = caseAuthority('R. v. Mohan, [1994] 2 SCR 9', 'https://canlii.ca/t/1frt1', 'admissibility of expert evidence (paragraphs to be supplied by the reviewer)')
const whiteBurgess = caseAuthority('White Burgess Langille Inman v. Abbott and Haliburton Co., 2015 SCC 23', 'https://canlii.ca/t/ghd4f', 'expert independence and gatekeeping (paragraphs to be supplied by the reviewer)')

const reviewerToConfirm = 'Case proposition not verified. Reviewer to confirm.'

function known<T>(value: T, authorities: RuleAuthority[], extra: Partial<Rule<T>> = {}): Rule<T> {
  return { status: 'known', value, authorities, asOf, reviewStatus: 'unreviewed', ...extra }
}

function unknown<T>(note: string, authorities: RuleAuthority[] = []): Rule<T> {
  return { status: 'unknown', value: null, authorities, asOf, reviewStatus: 'unreviewed', note }
}

export const ontarioCivilPack: JurisdictionRulePack = {
  schemaVersion: 1,
  id: 'ontario_civil_2026_11',
  title: 'Ontario civil jury trial (Superior Court of Justice)',
  jurisdiction: 'Ontario, Canada',
  rules: {
    juryAvailability: known(
      { available: true, judgeOnlyIssueKinds: [] },
      [statute('s. 108(1)', '108')],
      { note: 'A party may require a jury in a Superior Court action that is not in the Small Claims Court, unless otherwise provided. No issue kind is judge-only as such: exclusions apply to whole actions (see the next rule) or by order on motion.' },
    ),
    juryExclusions: known(
      [
        { id: 'injunction_or_mandatory_order', label: 'Claim for an injunction or mandatory order' },
        { id: 'partition_or_sale_of_real_property', label: 'Claim for partition or sale of real property' },
        { id: 'schedule_to_s_21_8_proceedings', label: 'Relief in proceedings referred to in the Schedule to section 21.8' },
        { id: 'dissolution_or_accounts', label: 'Dissolution of a partnership or taking of partnership or other accounts' },
        { id: 'foreclosure_or_redemption', label: 'Foreclosure or redemption of a mortgage' },
        { id: 'sale_of_property_subject_to_lien', label: 'Sale and distribution of proceeds of property subject to a lien or charge' },
        { id: 'execution_of_a_trust', label: 'Execution of a trust' },
        { id: 'rectification_or_cancellation_of_instrument', label: 'Rectification, setting aside or cancellation of a deed or other written instrument' },
        { id: 'specific_performance', label: 'Specific performance of a contract' },
        { id: 'declaratory_relief', label: 'Declaratory relief' },
        { id: 'other_equitable_relief', label: 'Other equitable relief' },
        { id: 'relief_against_a_municipality', label: 'Relief against a municipality' },
        { id: 'rule_76_action', label: 'Action proceeding under Rule 76 (the transitional exception in s. 108(2.1) applies to earlier jury notices)' },
        { id: 'order_on_motion', label: 'The court may order on motion that issues be tried or damages assessed without a jury (s. 108(3))' },
      ],
      [statute('s. 108(2), (2.1), (3)', '108')],
      { note: 'Wording read from an unofficial source; compare with e-Laws.' },
    ),
    panelSize: known(6, [statute('s. 108(4)', '108')]),
    decisionRule: known(
      { threshold: 5, differentMajorityPerQuestion: true },
      [statute('s. 108(6)', '108')],
      { note: 'It is sufficient if five of the jurors agree on the verdict or the answer to a question. Where more than one question is submitted, the same five need not agree to every answer.' },
    ),
    reducedPanelRule: known(
      { minimumJurors: 5, requiredAgreement: 'unanimous' },
      [statute('s. 108(7), (8)', '108')],
      { note: 'Where a juror dies or is discharged, the judge may direct that the trial proceed with five jurors, in which case the verdict or answers must be unanimous.' },
    ),
    verdictForm: known(
      { allowed: ['general', 'specific_questions'], chosenBy: 'judge' },
      [statute('s. 108(5)(a)', '108')],
      { note: 'Subject to section 15 of the Libel and Slander Act.' },
    ),
    faultApportionment: known(
      { apportioned: true, basis: 'Damages are apportioned in proportion to the degree of fault or negligence found against the parties.' },
      [negligenceAct],
    ),
    damagesCaps: unknown(
      'A rough upper limit on non-pecuniary damages exists in Canadian common law (Andrews trilogy). Its current indexed figure, how it is indexed and how it is put to a jury are not entered here. No figure is stated. Reviewer to enter the limit, its indexing and its authority.',
      [andrews, terNeuzen],
    ),
    punitiveAvailability: known(
      { available: true },
      [whiten],
      { toBeConfirmed: true, note: `${reviewerToConfirm} Availability and the conditions for it (for example an independent actionable wrong) are to be confirmed.` },
    ),
    punitiveStandard: unknown(
      'The standard for awarding and measuring punitive damages is not entered here. Reviewer to confirm and state it with pinpoints to Whiten.',
      [whiten],
    ),
    interest: unknown('Pre- and post-judgment interest rules are not entered here. Reviewer to enter them with their authorities.'),
    collateralBenefits: unknown('Treatment of collateral benefits and deductions is not entered here. Reviewer to enter it with its authorities.'),
    damagesCalculationOrder: unknown('The order in which caps, fault apportionment, deductions, interest and the other steps apply is not entered here. Reviewer to enter it.'),
    counselMaySuggestAmounts: known(
      { allowed: true, scope: 'Actions for damages for personal injury' },
      [statute('s. 118', '118')],
      { note: 'In such an action the court may give guidance to the jury on the amount of damages and the parties may make submissions to the jury on the amount.' },
    ),
    juryEligibility: unknown(
      'Who may serve on an Ontario civil jury is not entered here, so no population is narrowed to a jury pool. Reviewer to enter the eligibility criteria with their authorities (the Juries Act), or enter them for one matter as a recorded override.',
    ),
    damagesCategories: unknown(
      'The heads of damage a jury is asked to assess in an Ontario civil jury trial, and the local terms for them, are not entered here, so no per-category amounts can be requested from jurors. Reviewer to enter the categories and their local terms with their authorities, or enter them for one matter as a recorded override.',
    ),
    expertAdmissibility: known(
      {
        criteria: [
          { id: 'relevance', label: 'The evidence is relevant' },
          { id: 'necessity', label: 'The evidence is necessary to assist the trier of fact' },
          { id: 'no_exclusionary_rule', label: 'No exclusionary rule applies' },
          { id: 'properly_qualified', label: 'The expert is properly qualified, including being willing and able to give fair, objective and non-partisan evidence' },
          { id: 'gatekeeping', label: 'Discretionary gatekeeping: the benefits of admitting the evidence outweigh its costs' },
        ],
      },
      [mohan, whiteBurgess],
      { toBeConfirmed: true, note: reviewerToConfirm },
    ),
  },
}

