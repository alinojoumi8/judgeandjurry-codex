import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
describe('exhaustive source summary after a comparison clause',()=>{
 const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v79-captured-elided-only-summary-failure.json',import.meta.url),'utf8')),q=c.request
 const audit=(text:string)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'analysis',citations:[]}]}),[{id:'content:1',text}],q.evidence,q.groundingContext).status
 it('rejects the actual V79 accepted exhaustive omission',()=>expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext).status).toBe('failed'))
 it.each([
  'E-002 does not negate it, only records non-observation of a handover and Morgan leaving with the token.',
  'E-002 does not disprove that account, records only non-observation and departure.',
 ])('requires desk presence in the exhaustive elided-source summary: %s',text=>expect(audit(text)).toBe('failed'))
 it('preserves nonexhaustive, complete and explicitly scoped summaries',()=>{
  expect(audit('E-002 does not negate it, records non-observation and Morgan leaving with the token.')).toBe('passed')
  expect(audit('E-002 does not negate it, only records desk presence, non-observation and Morgan leaving with the token.')).toBe('passed')
  expect(audit('As to handover observation, E-002 does not negate it, only records non-observation of handover.')).toBe('passed')
 })
})

describe('V77 non-occurrence instruction attribution', () => {
 const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v77-captured-nonoccurrence-rule-failure.json',import.meta.url),'utf8')),q=c.request
 const audit=(text:string,instruction?:string)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'analysis',citations:[]}]}),[{id:'content:1',text}],q.evidence,q.groundingContext,undefined,{packet:q.packet,events:instruction?[{type:'judicial_instruction',payload:{text:instruction}}]:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
 it('rejects the captured accepted response without changing the valid low profile description',()=>expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,{actorId:q.courtroomActor.id,assessments:[],profile:q.jurorProfiles[0]},{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed'))
 it.each([
  'Tavi non-observation per the supplied rules does not negate Mira account.',
  'Per supplied instructions, non-observation does not negate the account.',
  'According to the current rules, non-observation does not negate the account.',
  'Under the limited-use rule, non-observation does not establish no handover occurred.',
  'Non-observation does not establish that no handover occurred under the limited-use rule.',
  'The charge says non-observation does not establish that none occurred.',
 ])('requires this claimed non-occurrence rule in the actual charge: %s',text=>expect(audit(text)).toBe('failed'))
 it('rejects the actual V78 plural-rules capture',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v78-captured-supplied-rules-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed')
 })
 it('permits an own comparison and an actually supplied comparison instruction',()=>{
  expect(audit('In my assessment, non-observation does not establish that no handover occurred.')).toBe('passed')
  expect(audit('Under the limited-use rule, non-observation does not establish no handover occurred.','Non-observation does not establish no handover occurred.')).toBe('passed')
 })
})

describe('V75 actual accepted field regressions', () => {
 const captured=JSON.parse(readFileSync(new URL('../docs/qa/jury/v75-captured-comparison-rule-failure.json',import.meta.url),'utf8')),q=captured.request
 const audit=(text:string,instruction?:string)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'analysis',citations:[]}]}),[{id:'content:1',text}],q.evidence,q.groundingContext,undefined,{packet:q.packet,events:instruction?[{eventId:'actual-charge',type:'judicial_instruction',actorId:'judge-1',phase:'instructions',payload:{text:instruction}}]:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
 it('permits an own comparison and an actually recorded comparison rule',()=>{
  expect(audit("I assess Tavi's non-observation as not directly negating Mira's account.")).toBe('passed')
  expect(audit('Under the limited-use rule, non-observation does not negate a handover.','Non-observation does not negate a handover.')).toBe('passed')
 })
 it.each(['Under the limited-use rule, non-observation does not negate a handover.','The source-use principle that non-observation does not negate a handover supports my assessment.'])('requires the claimed rule in the actual charge: %s',text=>expect(audit(text)).toBe('failed'))
 it.each(['primary-record','comparison-rule'])('rejects captured %s overclaim',name=>{
  const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v75-captured-${name}-failure.json`,import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles?.[0]},
   {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed')
 })
})
import type { StageRequest } from '../server/minimax'
import type { EvidenceItem, StageResult } from '../server/types'

describe('departure description does not supply personal observation',()=>{
 const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v76-captured-stated-departure-observation-failure.json',import.meta.url),'utf8')),q=c.request
 const audit=(text:string,evidence=q.evidence)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'analysis',citations:[]}]}),[{id:'content:1',text}],evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
 it('rejects the actual accepted V76 response',()=>expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed'))
 it.each(["Tavi's stated observation of departure with the token raises doubt.","Tavi's observation of Rowan's departure leaves doubt.","Tavi's reported observation of departure with the token leaves doubt."])('requires actual observation: %s',text=>expect(audit(text)).toBe('failed'))
 it('preserves narration, negated observation and an explicit personal observation',()=>{
  expect(audit("Tavi's account narrates departure with the token.")).toBe('passed')
  expect(audit("Tavi's account does not supply an observation of departure.")).toBe('passed')
  expect(audit("Tavi's stated observation of departure with the token raises doubt.",q.evidence.map((e:EvidenceItem)=>({...e,text:e.text.includes('Tavi states:')?e.text+' I saw Fictional Rowan leave with the token.':e.text})))).toBe('passed')
 })
})

const names = ['full-record', 'only-summary', 'category-proof-bar', 'departure-observation', 'v27:primary-corroboration', 'v27:nonobservation-contradiction', 'v27:direct-contradiction', 'v27:category-expanded', 'v28:authentication', 'v29:departure-actor', 'v30:pronoun-proof-bar', 'v30:credited-proof-bar', 'v31:departing-observation', 'v31:instruction-attribution-bar', 'v32:seeing-departure', 'v32:mutually-incompatible', 'v32:bare-burden-ban', 'v33:primary-exhibit', 'v33:departure-observation-noun', 'v34:coordinated-observation', 'v34:reversed-direct-conflict', 'v34:only-presence-omission', 'v35:possession-actor', 'v35:reordered-proof-bar', 'v35:insufficient-attribution', 'v37:pronominal-incompatibility', 'v37:exhibit-contradiction', 'v37:continuous-possession', 'v38:same-moment', 'v38:possessive-departure', 'v38:minimum-source-rule', 'v38:possession-observation', 'v39:suffix-only-summary', 'v40:quoted-departure-observation', 'v40:relative-source-incapacity', 'v41:coordinated-record-shield', 'v43:earlier-handover', 'v45:plural-contradiction', 'v47:instruction-comparison', 'v48:concurrent-timing', 'v49:unsupplied-honorific']
describe('captured V26 scope errors', () => {
  it.each(names)('rejects the accepted %s response against its actual inputs', name => {
    const version = name.match(/^(v\d+):/)?.[1] ?? 'v26'
    const captureName = name.replace(/^v\d+:/, '')
    const c = JSON.parse(readFileSync(new URL(`../docs/qa/jury/${version}-captured-${captureName}-failure.json`, import.meta.url), 'utf8')) as { request: StageRequest; result: StageResult }
    const q = c.request, findings = c.result.grounding!.findings
    const review = reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings }), version === 'v49' ? groundingUnits(c.result) : findings.map(f => ({ id: f.unitId, text: f.text })), q.evidence, q.groundingContext,
      { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] },
      { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], stage: q.stage, courtroomState: q.courtroomState })
    expect(review.status).toBe('failed')
  })
})

const mira = { exhibitId: 'E-001', text: 'Mira states: I saw Fictional Morgan hand the sealed envelope to Fictional Ellis. I do not know what the envelope contained.' } as EvidenceItem
const tavi = { exhibitId: 'E-002', text: 'Tavi states: I saw Fictional Ellis standing at the desk. Fictional Morgan left with the blue token still in their hand. I did not see a handover.' } as EvidenceItem
const assessment = 'E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.\nE-002: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.'
const check = (text: string, evidence = [mira, tavi], context = assessment) => reviewWithIndependentScopeCheck('analysis',
  JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: evidence.map(e => ({ exhibitId: e.exhibitId, paragraph: 1 })) }] }), [{ id: 'content:1', text }], evidence, context,
).status
it('preserves the actual negated affirmative comparison falsely rejected by the V74 checker', () => {
 const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v74-captured-negated-affirmative-false-rejection.json',import.meta.url),'utf8'))
 const review=reviewWithIndependentScopeCheck('analysis', JSON.stringify(c.review),groundingUnits(c.draft),c.request.evidence,c.request.groundingContext)
 expect(review.status).toBe('passed')
 const opposing=c.request.evidence.map((e:EvidenceItem,i:number)=>i===1?{...e,text:'Tavi states: Fictional Rowan did not hand a blue token to Fictional Ellis at the desk.'}:e)
 expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify(c.review),groundingUnits(c.draft),opposing,c.request.groundingContext).status).toBe('failed')
})
describe('record scope and assessment boundaries', () => {
  it('preserves classification status and the correctly named possession actor', () => {
    const unknown = assessment + '\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;';
    expect(check('Neither is primary-classified.', [mira, tavi], unknown)).toBe('passed');
    expect(check("Tavi's description of Morgan's later possession leaves doubt.", [tavi])).toBe('passed');
    expect(check("Tavi's later possession leaves doubt.", [{ ...tavi, text: tavi.text.replace('Fictional Morgan left', 'Fictional Tavi left') }])).toBe('passed');
    expect(check('These disputed attributed accounts cannot meet the burden on this record.')).toBe('passed');
  })

  it('preserves sourced coordination and scoped summaries', () => {
    expect(check('Tavi describes seeing Ellis at the desk and Morgan leaving with the token.', [tavi])).toBe('failed');
    expect(check('Tavi describes seeing Ellis at the desk and Morgan leaving with the token.', [{ ...tavi, text: tavi.text + ' I saw Ellis at the desk and Morgan leaving with the token.' }])).toBe('passed');
    expect(check('As to handover observation, Tavi states only that no handover was seen.', [tavi])).toBe('passed');
    expect(check('Tavi states only desk presence, Morgan leaving with the token and no handover seen.', [tavi])).toBe('passed');
    expect(check('The accounts do not conflict directly on receipt.')).toBe('passed');
  })

  it('keeps unknown classification distinct from absent primary exhibits', () => {
    const unknown = assessment + '\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;';
    expect(check('No primary exhibit is supplied.', [mira, tavi], unknown)).toBe('failed');
    expect(check('No source is classified as a primary document in the usable record.', [mira, tavi], unknown)).toBe('passed');
    expect(check('If no primary exhibit is supplied, I would assess the accounts.', [mira, tavi], unknown)).toBe('passed');
    expect(check('No primary exhibit is supplied.', [mira, tavi], assessment + '\nRecord classification: verified no supplied exhibit is primary.')).toBe('passed');
  })

  it('preserves full-account quotation framing and neutral record completeness questions', () => {
    expect(check('That is the full supplied account as quoted.', [mira])).toBe('passed')
    expect(check('Is that the full supplied record?', [mira])).toBe('passed')
    expect(check('It is incorrect to say that is the full supplied record.', [mira])).toBe('passed')
  })
  it('preserves scoped contents summaries and current burden assessments', () => {
    expect(check('As to contents, E-001 states only that the envelope was sealed and Mira does not know what it contained.', [mira])).toBe('passed')
    expect(check('E-001 records a handover and unknown contents.', [mira])).toBe('passed')
    expect(check('On this record, these disputed accounts do not satisfy the burden because they conflict.')).toBe('passed')
    expect(check('I am not satisfied by these accounts beyond a reasonable doubt.')).toBe('passed')
  })
  it('preserves actual departure description and explicitly sourced observation', () => {
    expect(check('Tavi describes Morgan leaving with the token and states no handover was seen.', [tavi])).toBe('passed')
    expect(check('The account does not establish that Tavi saw Morgan leave.', [tavi])).toBe('passed')
    expect(check('Does Tavi state an observation of Morgan leaving?', [tavi])).toBe('passed')
    expect(check('Tavi saw Morgan leave with the token.', [{ ...tavi, text: tavi.text + ' I saw Fictional Morgan leave with the token.' }])).toBe('passed')
  })
  it('requires current record coverage rather than a complete source quote', () => {
    expect(check('That is the full supplied record.', [mira])).toBe('failed')
    expect(check('That is the full supplied record.', [mira], assessment + '\nRecord coverage: The supplied record is explicitly confirmed complete for this request.')).toBe('passed')
    expect(check('If that is the full supplied record, I would assess it accordingly.', [mira])).toBe('passed')
  })
  it('rejects exhaustive summary omissions and generic source-class incapacity', () => {
    expect(check('E-001 (fictional-mira.txt) states only sealed and unknown contents.', [mira])).toBe('failed')
    expect(check('The burden cannot be met by attributed statements alone.')).toBe('failed')
    expect(check('Exclusively attributed disputed material cannot establish the receipt condition beyond a reasonable doubt.')).toBe('failed')
    expect(check('It is incorrect to say attributed statements alone cannot establish the receipt condition.')).toBe('passed')
  })
  it('distinguishes possible conflict from directly incompatible event propositions', () => {
    expect(check('The accounts directly contradict on the handover.')).toBe('failed')
    expect(check('The position rests on the contradiction between E-001 and E-002.')).toBe('failed')
    expect(check('The contradiction between E-001 and E-002 may explain doubt.')).toBe('failed')
    expect(check('There may be a contradiction between E-001 and E-002.')).toBe('passed')
    expect(check('E-001 describes a handover; E-002 states no handover seen. These are incompatible.')).toBe('failed')
    expect(check('These may be incompatible on receipt.')).toBe('passed')
    expect(check('These are not incompatible on receipt.')).toBe('passed')
    expect(check('These are incompatible.', [mira, { ...tavi, text: 'Tavi states: No handover occurred.' }])).toBe('passed')
    expect(check('This direct contradiction on the receipt element leaves doubt.')).toBe('failed')
    expect(check('The accounts raise doubt about receipt.')).toBe('passed')
    expect(check('The accounts may conflict on receipt.')).toBe('passed')
    expect(check('The accounts are not directly incompatible on receipt.')).toBe('passed')
    expect(check('The accounts may be mutually incompatible on receipt.')).toBe('passed')
    expect(check('These accounts do not directly contradict on the handover.')).toBe('passed')
    expect(check('If the accounts directly contradicted on receipt, that would affect my assessment.')).toBe('passed')
    expect(check('The accounts directly contradict on the handover.', [mira, { ...tavi, text: 'Tavi states: No handover occurred.' }])).toBe('passed')
  })
  it('checks contradiction premises even when the ballot reason omits the element name', () => {
    expect(check('The position rests on the direct contradiction between the two attributed accounts.')).toBe('failed')
    expect(check('The contradiction triggers my doubt standard.')).toBe('failed')
    expect(check('The accounts contradict on receipt.')).toBe('failed')
    expect(check('The accounts may contradict on receipt.')).toBe('passed')
    expect(check('I cannot conclude the accounts contradict on receipt.')).toBe('passed')
    expect(check('It is incorrect to say the accounts contradict on receipt.')).toBe('passed')
  })
  it('preserves missing authentication status without asserting its opposite', () => {
    const unknown = assessment + '\nE-001: Authentication status is unknown.'
    expect(check('E-001 is an unauthenticated account.', [mira], unknown)).toBe('failed')
    expect(check('E-001 is not authenticated.', [mira], unknown)).toBe('failed')
    expect(check('Authentication status is unknown.', [mira], unknown)).toBe('passed')
    expect(check('It is incorrect to say E-001 is unauthenticated merely because its authentication status is unknown.', [mira], unknown)).toBe('passed')
    expect(check('Is E-001 unauthenticated?', [mira], unknown)).toBe('passed')
    expect(check('E-001 is unauthenticated.', [mira], assessment + '\nE-001: unauthenticated; authentication status verified.')).toBe('passed')
  })
  it('keeps the narrated departure actor separate from the witness speaker', () => {
    expect(check('Tavi left with the token.', [tavi])).toBe('failed')
    expect(check("Tavi's non-observation and later departure do not directly contradict.", [tavi])).toBe('failed')
    expect(check("Tavi's non-observation and Morgan's later departure do not directly contradict.", [tavi])).toBe('passed')
    expect(check("Tavi's account records non-observation and later departure.", [tavi])).toBe('passed')
    expect(check('E-002 has Tavi stating no handover was observed and departing with it.', [tavi])).toBe('failed')
    expect(check('Tavi states no handover was seen and Morgan departed with the token.', [tavi])).toBe('passed')
    expect(check('Tavi describes Morgan leaving with the token.', [tavi])).toBe('passed')
    expect(check('Did Tavi depart with the token?', [tavi])).toBe('passed')
    expect(check('Tavi left with the token.', [{ ...tavi, text: 'Tavi states: Fictional Tavi left with the blue token still in hand.' }])).toBe('passed')
  })
  it('rejects source-class incapacity through a pronoun or after crediting', () => {
    expect(check('The Crown bears the burden on receipt, and attributed material alone cannot satisfy it.')).toBe('failed')
    expect(check('Attribution alone cannot meet the burden, so receipt is not established regardless of which account is credited.')).toBe('failed')
    expect(check('Regardless of which account is credited, the Crown bears the burden.')).toBe('passed')
    expect(check('Mere attribution is not an established finding. I assess the admitted accounts under the supplied condition.')).toBe('passed')
  })
})
describe('bounded inverse contradiction correction', () => {
  it('preserves the actual captured inverse claim with verified complete source quotations', () => {
    const c = JSON.parse(readFileSync(new URL('../docs/qa/jury/v30-captured-direct-polarity-failure.json', import.meta.url), 'utf8')) as { request: StageRequest; result: StageResult }
    const findings = c.result.grounding!.findings, units = findings.map(f => ({ id: f.unitId, text: f.text }))
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings }), units, c.request.evidence, c.request.groundingContext).status).toBe('passed')
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: findings.map(f => ({ ...f, citations: [] })) }), units, c.request.evidence, c.request.groundingContext).status).toBe('failed')
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings }), units, c.request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: No handover occurred.' } : e), c.request.groundingContext).status).toBe('failed')
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings }), [{ ...units[0], text: units[0].text + ' The envelope contained cash.' }], c.request.evidence, c.request.groundingContext).status).toBe('failed')
  })
})

describe('captured neutral and entailed source false rejections', () => {
  it.each(['neutral-authentication', 'entailed-self-departure'])('preserves the bounded %s control', name => {
    const c = JSON.parse(readFileSync(new URL(`../docs/qa/jury/v36-captured-${name}-false-rejection.json`, import.meta.url), 'utf8')) as { request: StageRequest; result: StageResult }
    const findings = c.result.grounding!.findings, units = findings.map(f => ({ id: f.unitId, text: f.text }))
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings }), units, c.request.evidence, c.request.groundingContext).status).toBe('passed')
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings }), units.map(u => ({ ...u, text: u.text + ' The envelope contained cash.' })), c.request.evidence, c.request.groundingContext).status).toBe('failed')
    if (name === 'entailed-self-departure') {
      expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: findings.map(f => ({ ...f, citations: [] })) }), units, c.request.evidence, c.request.groundingContext).status).toBe('failed')
      const changed = c.request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: Fictional Morgan left with the blue token still in hand.' } : e)
      const quoted = findings.map(f => ({ ...f, citations: [{ exhibitId: 'E-002', paragraph: 1 }] }))
      expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: quoted }), units, changed, c.request.groundingContext).status).toBe('failed')
    }
  })
})

describe('continuous token possession needs its own source support', () => {
  it('preserves narrated departure and rejects strengthening it into continuity', () => {
    expect(check('The token stayed with Morgan.', [tavi])).toBe('failed')
    expect(check('The token may have stayed with Morgan.', [tavi])).toBe('passed')
    expect(check('Tavi states Morgan left with the token still in hand.', [tavi])).toBe('passed')
    expect(check('The token stayed with Morgan.', [{ ...tavi, text: tavi.text + ' The token stayed with Morgan.' }])).toBe('passed')
  })
})

describe('common event timing needs its own source support', () => {
  it('preserves timing uncertainty instead of synchronizing separate accounts', () => {
    expect(check('The accounts describe the same moment.')).toBe('failed')
    expect(check('The accounts may describe the same moment.')).toBe('passed')
    expect(check('The accounts do not establish the same moment.')).toBe('passed')
    expect(check('The accounts describe the same moment.', [{ ...mira, text: mira.text + ' The accounts describe the same moment.' }, tavi])).toBe('passed')
  })
})

describe('the supplied burden does not impose a minimum source count', () => {
  it('preserves personal doubt without inventing a universal source-count rule', () => {
    expect(check("The Crown's burden requires more than a single attributed account.")).toBe('failed')
    expect(check('I retain doubt after weighing this single attributed account.')).toBe('passed')
    expect(check('The burden does not require more than a single attributed account.')).toBe('passed')
  })
})

describe('possession narration is not possession observation', () => {
  it('requires a source observation by the named witness', () => {
    expect(check('E-002 records a later possession observation.', [tavi])).toBe('failed')
    expect(check('E-002 records a later possession description.', [tavi])).toBe('passed')
    expect(check('E-002 records a later possession observation.', [{ ...tavi, text: tavi.text + ' I saw Fictional Morgan holding the token later.' }])).toBe('passed')
  })
})

describe('minimum-source rules come from the pinned charge', () => {
  it('preserves an expressly supplied fictional rule without importing advocacy', () => {
    const text = "The Crown's burden requires more than a single attributed account."
    const audit = (packet: string) => reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }), [{ id: 'content:1', text }], [mira, tavi], assessment, undefined, { packet, events: [], actorRoles: ['juror'], partyRoles: [] }).status
    const pinned = 'Pinned legal packet fixture: ' + JSON.stringify({ instructions: [{ text }] })
    expect(audit(pinned)).toBe('passed')
    expect(audit('Approved Crown advocacy: ' + text)).toBe('failed')
  })
})

describe('suffix-only summaries preserve the complete source scope', () => {
  it('rejects exhaustive non-observation while preserving a scoped excerpt', () => {
    expect(check('E-002 records non-observation only.', [tavi])).toBe('failed')
    expect(check('On the handover observation, E-002 records non-observation only.', [tavi])).toBe('passed')
    expect(check('E-002 records non-observation only.', [{ ...tavi, text: 'Tavi states: I did not see a handover.' }])).toBe('passed')
    expect(check('E-002 records non-observation only.', [{ ...tavi, text: 'Tavi states: Morgan left with the token. I did not see a handover.' }])).toBe('failed')
    expect(check('E-002 records non-observation only; it also records Ellis standing at the desk and Morgan leaving with the token.', [tavi])).toBe('failed')
  })
})

describe('quotation wrappers retain the source observation predicate', () => {
  it('distinguishes a narrated quote from an actual observation', () => {
    const narrated = `Tavi saw 'Fictional Morgan left with the blue token still in their hand' (E-002).`
    expect(check(narrated, [tavi])).toBe('failed')
    expect(check(`Tavi states 'Fictional Morgan left with the blue token still in their hand' (E-002).`, [tavi])).toBe('passed')
    expect(check(narrated, [{ ...tavi, text: tavi.text + ' I saw Fictional Morgan leave with the blue token.' }])).toBe('passed')
  })
})

describe('source incapacity cannot hide in a relative or coordinated clause', () => {
  it('preserves individual assessment while rejecting an invented exclusive genre bar', () => {
    expect(check('Both supplied exhibits are exclusively attributed accounts and cannot satisfy the burden.')).toBe('failed')
    expect(check('The supplied record contains exclusively attributed material, which cannot satisfy the burden.')).toBe('failed')
    expect(check('These accounts are exclusively attributed, but I cannot find receipt established on this record.')).toBe('passed')
    expect(check('These disputed attributed accounts cannot meet the burden on this record.')).toBe('passed')
    expect(check('Exclusively attributed accounts may satisfy the burden if credited.')).toBe('passed')
  })
})

describe('coordinated predicates keep their account antecedent', () => {
  it('audits the entire factual premise before a negative proof clause', () => {
    expect(check('The accounts are disputed and incompatible, and attribution does not establish the event.')).toBe('failed')
    expect(check('The accounts are disputed and may be incompatible, and attribution does not establish the event.')).toBe('passed')
    expect(check('The accounts are disputed and not incompatible, and attribution does not establish the event.')).toBe('passed')
    expect(check('The accounts are disputed and incompatible, and attribution does not establish the event.', [mira, { ...tavi, text: 'Tavi states: No handover occurred.' }])).toBe('passed')
  })
})

describe('a mixed public-record attribution does not shield an own source premise', () => {
  it('preserves actual reports without adopting their factual truth', () => {
    const c = JSON.parse(readFileSync(new URL('../docs/qa/jury/v41-captured-coordinated-record-shield-failure.json', import.meta.url), 'utf8')) as { request: StageRequest; result: StageResult }
    const audit = (text: string, recordText: string) => {
      const event = c.request.courtroomEvents!.find(e => e.type === 'public_submission' && e.actorId === 'crown')!
      return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [], recordCitations: [{ eventId: event.eventId, actorId: event.actorId, quote: recordText }] }] }), [{ id: 'content:1', text }], c.request.evidence, c.request.groundingContext, undefined, { packet: c.request.packet, events: [{ ...event, payload: { ...event.payload, text: recordText } }], actorRoles: ['juror'], partyRoles: c.request.approvedPartyRoles! }).status
    }
    expect(audit("The attributed accounts are incompatible, and the Crown's own submission concedes the record does not resolve the condition.", 'The supplied record does not resolve the condition.')).toBe('failed')
    expect(audit("The attributed accounts remain disputed, and the Crown's own submission concedes the record does not resolve the condition.", 'The supplied record does not resolve the condition.')).toBe('passed')
    expect(audit("The Crown states 'The accounts are incompatible.'", 'The accounts are incompatible.')).toBe('passed')
    expect(audit("The accounts are incompatible according to the Crown's submission.", 'The accounts are incompatible.')).toBe('passed')
  })
})


describe('V42 captured false-rejection boundaries', () => {
  it.each(['limited-proof', 'verified-classification'])('preserves the bounded %s claim without overriding an actual model rejection', name => {
    const c = JSON.parse(readFileSync(new URL(`../docs/qa/jury/v42-captured-${name}-false-rejection.json`, import.meta.url), 'utf8'))
    const q = c.request, units = [{ id: 'content:1', text: c.draft.content }]
    const evaluate = (status: string) => reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [] }] }), units, q.evidence, q.groundingContext,
      { actorId: q.courtroomActor?.id, assessments: q.courtroomAssessments ?? [] },
      { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage, courtroomState: q.courtroomState })
    expect(evaluate('analysis').status).toBe('passed')
    expect(evaluate('unsupported').status).toBe('failed')
  })
})


describe('cross-account earlier-event premises', () => {
  it('rejects definite chronology even in a negative event-conflict conclusion', () => {
    expect(check("Tavi's non-observation does not directly negate the earlier handover.")).toBe('failed')
  })
  it('preserves hypothetical prior events, missing chronology and expressly recorded chronology', () => {
    expect(check("Tavi's non-observation does not directly deny a prior handover.")).toBe('passed')
    expect(check('If the handover was earlier, the non-observation might not resolve it.')).toBe('passed')
    expect(check('The accounts do not establish an earlier handover.')).toBe('passed')
    expect(check("Tavi's account does not negate the earlier handover.", [{ ...mira, text: mira.text + ' This handover was earlier than the departure described by Tavi.' }, tavi])).toBe('passed')
  })
})


describe('plural contradiction source boundary', () => {
 it('rejects a plural noun used as an asserted premise', () => expect(check('The contradictions leave the Crown short on the element.')).toBe('failed'))
 it('preserves modal or denied contradictions and actual opposite event propositions', () => {
  expect(check('The accounts may contain contradictions.')).toBe('passed')
  expect(check('No contradictions are established by these sources.')).toBe('passed')
  expect(check('The contradictions leave the Crown short on the element.', [mira,{...tavi,text:'Tavi states: No handover occurred.'}])).toBe('passed')
 })
})


describe('pure conditional assessment false rejection', () => {
 const rejected=(text: string)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'unsupported',citations:[]}]}),[{id:'content:1',text}],[mira,tavi],assessment).status
 it('preserves a wholly hypothetical assessment implication after a model false rejection',()=>expect(rejected('If that account directly negates the handover, it matters to assessment.')).toBe('passed'))
 it('does not clear an added assertion, an attribution or an invented assessment permission',()=>{
  expect(rejected('If that account directly negates the handover, it matters to assessment. That account directly negates the handover.')).toBe('failed')
  expect(rejected('If the Crown says that account directly negates the handover, it matters to assessment.')).toBe('failed')
  expect(rejected('If that account directly negates the handover, the instruction requires using it as proof.')).toBe('failed')
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'unsupported',citations:[]}]}),[{id:'content:1',text:'If that account directly negates the handover, it matters to assessment.'}],[mira], 'E-001: limited; permitted purposes: Accurately attribute the disputed account.').status).toBe('failed')
 })
})

describe('source guidance is not a recorded judicial instruction', () => {
 const compare = (text: string, instructions: string[] = [], events: Array<{eventId:string;type:string;actorId:string;payload:Record<string,unknown>}> = []) => reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'analysis',citations:[]}]}), [{id:'content:1',text}], [mira,tavi], assessment, undefined, {packet:'Pinned legal packet test: '+JSON.stringify({instructions:instructions.map(text=>({text}))}),events,actorRoles:['juror'],partyRoles:[]}).status
 const rule='Non-observation does not directly contradict a handover.'
 it('rejects a rule attributed to an instruction that does not contain it',()=>{
  expect(compare('The instruction states non-observation does not directly contradict.')).toBe('failed')
  expect(compare('Non-observation does not directly contradict per the instruction.')).toBe('failed')
 })
 it('rejects the captured limited-use attribution in every accepted field',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v66-captured-instruction-comparison-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles?.[0]},
   {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed')
 })
 it.each([
  'Per the limited-use instruction, non-observation does not directly contradict the handover.',
  'Non-observation does not directly contradict the handover per the limited_use instruction.',
  'Under the judicial instruction, non-observation does not directly contradict the handover.',
  'According to the source-use charge, non-observation does not directly contradict the handover.',
 ])('rejects qualified instruction attribution: %s',text=>expect(compare(text)).toBe('failed'))
 it('keeps actual instruction attribution, own assessment and conditional attribution distinct',()=>{
  const text='Per the limited-use instruction, non-observation does not directly contradict the handover.'
  expect(compare(text,[rule])).toBe('passed')
  expect(compare('Under the supplied burden, I assess non-observation as not directly contradicting the handover.')).toBe('passed')
  expect(compare('If the limited-use instruction states non-observation does not directly contradict, I would consider that guidance.')).toBe('passed')
 })
 it('preserves own comparisons and actual recorded instruction text',()=>{
  expect(compare('I assess the non-observation as not directly contradicting the handover.')).toBe('passed')
  expect(compare('The instruction states non-observation does not directly contradict.',[rule])).toBe('passed')
  expect(compare('Non-observation does not directly contradict per the instruction.',[],[{eventId:'instruction',type:'judicial_instruction',actorId:'judge',payload:{text:rule}}])).toBe('passed')
 })
 it('does not promote an advocate submission into judicial authority',()=>expect(compare('The instruction states non-observation does not directly contradict.',[],[{eventId:'submission',type:'public_submission',actorId:'crown',payload:{text:rule}}])).toBe('failed'))
 it('preserves hypothetical or denied attributions',()=>{
  expect(compare('If the instruction states non-observation does not directly contradict, I would consider that guidance.')).toBe('passed')
  expect(compare('The instruction does not state non-observation does not directly contradict.')).toBe('passed')
 })
})

describe('separate account statements do not supply event concurrency', () => {
 it('rejects synchronized desk observation and departure',()=>expect(check('Tavi saw Ellis at the desk while Morgan departed with the token.')).toBe('failed'))
 it('preserves source-stated timing, missing timing and contrasting accounts',()=>{
  expect(check('Tavi saw Ellis at the desk while Morgan departed with the token.', [{...tavi,text:tavi.text+' I saw Ellis at the desk while Morgan departed with the token.'}])).toBe('passed')
  expect(check('It is not established that Tavi saw Ellis at the desk while Morgan departed with the token.')).toBe('passed')
  expect(check("Mira describes a handover while Tavi's account describes departure.")).toBe('passed')
 })
})

describe('event timing and polarity survive paraphrases', () => {
 it.each(['Tavi states Ellis stood at the desk while Morgan departed with the token.', 'Tavi describes Ellis standing at the desk while Morgan left with the token.'])('rejects unsupplied concurrency: %s', text => expect(check(text)).toBe('failed'))
 it('preserves actual concurrent timing and explicit hypotheses', () => {
  expect(check('Tavi states Ellis stood at the desk while Morgan departed with the token.', [{...tavi,text:tavi.text+' Ellis stood at the desk while Morgan departed with the token.'}])).toBe('passed')
  expect(check('If Ellis stood at the desk while Morgan departed, that may matter.')).toBe('passed')
  expect(check('The account does not establish that Ellis stood at the desk while Morgan departed.')).toBe('passed')
 })
 it('requires opposite event propositions for a definite handover-polarity conflict', () => {
  expect(check('The accounts conflict on whether a handover occurred.')).toBe('failed')
  expect(check('The accounts may conflict on whether a handover occurred.')).toBe('passed')
  expect(check('The accounts do not conflict on whether a handover occurred.')).toBe('passed')
  expect(check('The accounts conflict on whether a handover occurred.', [mira,{...tavi,text:'Tavi states: No handover occurred.'}])).toBe('passed')
  expect(check('The conflicting accounts leave me uncertain.')).toBe('passed')
 })
 it.each(['stood-while', 'handover-conflict'])('rejects the actual accepted V50 %s output', name => {
  const c = JSON.parse(readFileSync(new URL(`../docs/qa/jury/v50-captured-${name}-failure.json`, import.meta.url), 'utf8'))
  const q = c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}), groundingUnits(c.result), q.evidence, q.groundingContext,
   {actorId:q.courtroomActor.id, assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
})

describe('proof verbs do not change a source incapacity rule', () => {
 it.each(['Exclusively attributed material cannot prove receipt beyond a reasonable doubt.', 'Under the limited-use rule, attributed material cannot prove the receipt condition.', 'Attributed accounts alone cannot prove the condition.'])('rejects invented class incapacity: %s', text => expect(check(text)).toBe('failed'))
 it('preserves own current doubt and denied class restrictions', () => {
  expect(check('I cannot prove receipt from these accounts on this record.')).toBe('passed')
  expect(check('These attributed accounts cannot prove receipt on this supplied record.')).toBe('passed')
  expect(check('Exclusively attributed material may prove receipt if credited.')).toBe('passed')
  expect(check('The rule does not say attributed material cannot prove receipt.')).toBe('passed')
 })
 it('rejects the actual accepted V51 ballot', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v51-captured-exclusive-prove-bar-failure.json',import.meta.url),'utf8')), q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
})

describe('received event polarity and verified-status wording', () => {
 it('rejects definite received-event conflict while preserving hypotheses', () => {
  expect(check('The accounts conflict on whether Ellis received a token from Morgan.')).toBe('failed')
  expect(check('The accounts may conflict on whether Ellis received a token from Morgan.')).toBe('passed')
  expect(check('The accounts do not conflict on whether Ellis received a token from Morgan.')).toBe('passed')
 })
 it('rejects the actual accepted V52 received-event claim', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v52-captured-received-conflict-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
 it('preserves exact unknown verified-documentary-status wording, but no strengthened absence or supplied classification', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v52-captured-verified-documentary-false-rejection.json',import.meta.url),'utf8')),q=c.control.request
  const audit=(text:string,context=q.groundingContext)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'unsupported',citations:[]}]}),[{id:'content:1',text}],q.evidence,context).status
  expect(audit('No verified documentary support is supplied; documentary status remains unknown.')).toBe('passed')
  expect(audit('No documentary support is supplied; documentary status remains unknown.')).toBe('failed')
  expect(audit('No verified documentary support is supplied; documentary status remains unknown. Additional evidence does not exist.')).toBe('failed')
  expect(audit('No verified documentary support is supplied; documentary status remains unknown.',q.groundingContext.replace('E-001: unclassified; unknown;','E-001: primary document; verified;'))).toBe('failed')
 })
})

describe('qualified possessives preserve the departing actor', () => {
 it.each(["Tavi's E-002 non-observation of a handover and later departure with the token leave doubt.", "Tavi's E-002 stated non-observation and departure with the token leave doubt."])('rejects an exhibit-qualified reassignment: %s', text => expect(check(text)).toBe('failed'))
 it('preserves named exhibit-qualified departure and source reporting', () => {
  expect(check("Tavi's E-002 non-observation and Morgan's departure with the token leave doubt.")).toBe('passed')
  expect(check("Tavi's E-002 records non-observation and later departure with the token.")).toBe('passed')
  expect(check("Tavi's E-002 non-observation and departure with the token leave doubt.",[{...tavi,text:tavi.text.replace('Fictional Morgan left','Fictional Tavi left')}])).toBe('passed')
 })
 it('rejects the actual accepted V55 exhibit-qualified possessive', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v55-captured-exhibit-possessive-departure-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
 it.each(["Tavi's stated non-observation of a handover and departure with the token leave doubt.", "Tavi's recorded non-observation and later departure with the token leave doubt.", "Tavi's non-observation of the handover and departure with the token leave doubt."])('rejects reassigned departure: %s', text => expect(check(text)).toBe('failed'))
 it('preserves a separately named departing actor and an actual speaker departure', () => {
  expect(check("Tavi's stated non-observation of a handover and Morgan's departure with the token leave doubt.")).toBe('passed')
  expect(check("Tavi's stated non-observation of a handover and departure with the token leave doubt.", [{...tavi,text:tavi.text.replace('Fictional Morgan left','Fictional Tavi left')}])).toBe('passed')
 })
 it('rejects the actual accepted V53 qualified possessive', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v53-captured-qualified-possessive-departure-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
})

describe('documentary absence requires supplied classification', () => {
 const unknown = assessment + '\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;'
 it.each(['The permitted record is without documentary corroboration.', 'These accounts leave no documentary resolution.', 'The supplied record lacks documentary support.'])('rejects strengthened documentary absence: %s', text => expect(check(text, [mira, tavi], unknown)).toBe('failed'))
 it('preserves verification qualifiers, questions and hypothetical absence', () => {
  expect(check('No verified documentary support is supplied; documentary status remains unknown.', [mira, tavi], unknown)).toBe('passed')
  expect(check('Is the permitted record without documentary corroboration?', [mira, tavi], unknown)).toBe('passed')
  expect(check('If the record lacks documentary support, I would assess that gap.', [mira, tavi], unknown)).toBe('passed')
  expect(check('It is incorrect to claim the record is without documentary corroboration merely because classification is unknown.', [mira, tavi], unknown)).toBe('passed')
  expect(check('It is incorrect to claim the record is without documentary corroboration; the record lacks documentary support.', [mira, tavi], unknown)).toBe('failed')
  expect(check('The record is without documentary corroboration.', [mira, tavi], assessment + '\nRecord classification: verified no supplied source provides documentary corroboration.')).toBe('passed')
 })
 it('rejects every actual V54 ballot field accepting documentary absence', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v54-captured-documentary-corroboration-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
})

describe('witness names do not supply gendered honorifics', () => {
 it('keeps an abbreviated address in the complete audit unit',()=>expect(groundingUnits({title:'Question',content:'Ms. Mira, describe your account.',citations:[],jurors:[]}).find(u=>u.id==='content:1')?.text).toBe('Ms. Mira, describe your account.'))
 it.each(['Ms.', 'Mr.', 'Mrs.', 'Miss'])('rejects an unsupplied %s address',honorific=>expect(check(`${honorific} Mira, please describe your account.`,[mira])).toBe('failed'))
 it('preserves the supplied name and a matching explicitly supplied honorific',()=>{
  expect(check('Mira, please describe your account.',[mira])).toBe('passed')
  expect(check('Ms. Mira, please describe your account.',[{...mira,text:'Ms. Mira states: I saw Fictional Morgan hand the envelope to Ellis.'}])).toBe('passed')
  expect(check('Mr. Mira, please describe your account.',[{...mira,text:'Ms. Mira states: I saw Fictional Morgan hand the envelope to Ellis.'}])).toBe('failed')
 })
})

describe('captured V56 proof and explicit classification boundaries', () => {
 it.each(['unverified-proof-bar','corrob-primary-absence'])('rejects actual accepted %s response', name => {
  const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v56-captured-${name}-failure.json`,import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
 it('preserves exact supplied documentary absence despite a rejecting checker', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v56-captured-explicit-documentary-false-rejection.json',import.meta.url),'utf8')),q=c.control.request
  const audit=(text:string,context=q.groundingContext)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'unsupported',citations:[]}]}),[{id:'content:1',text}],q.evidence,context).status
  expect(audit('The record is without documentary corroboration.')).toBe('passed')
  expect(audit('The record is without documentary corroboration.',q.groundingContext.replaceAll('Record classification: verified no supplied source provides documentary corroboration.','Record classification: unknown.'))).toBe('failed')
  expect(audit('The record is without documentary corroboration. No evidence exists.')).toBe('failed')
  expect(audit('The record is without primary support.')).toBe('failed')
 })
 it.each(['Two conflicting accounts, neither independently verified, cannot meet proof beyond a reasonable doubt.', 'Unverified accounts cannot establish proof beyond reasonable doubt.', 'The accounts are neither independently verified.', 'Without corroboration or primary support, the Crown burden is not met.'])('rejects unknown status strengthened into absence or incapacity: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('failed'))
 it.each(['These conflicting accounts cannot establish proof beyond reasonable doubt on this record.', 'I find the supplied accounts insufficient on this record.', 'Independent verification is not supplied; verification remains unknown.', 'If corroboration or primary support is absent, that would inform my assessment.', 'The rule does not say conflicting accounts cannot meet proof beyond reasonable doubt.'])('preserves current assessments and qualified unknowns: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed'))
})

describe('observation nouns preserve supplied eyewitness scope', () => {
 it.each(['stated-observation','two-observations','departure-observation'])('rejects actual V57 %s response',name=>{
  const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v57-captured-${name}-failure.json`,import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments ?? []},
   {packet:q.packet,events:q.courtroomEvents ?? [],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles ?? [],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
 it.each(["Tavi's stated observation that Fictional Morgan departed with the token supports doubt.","E-002 records Tavi's observation of Fictional Morgan departing with the token.","E-002's later departure observation supports doubt.","Tavi describes Ellis at the desk and Morgan leaving. Those two observations carry unspecified timing."])('rejects added observation provenance: %s',text=>expect(check(text)).toBe('failed'))
 it.each(["Tavi reports Morgan departing with the token.","Tavi's observation of Ellis at the desk and separately narrated Morgan departure carry unspecified timing.","E-002 does not establish a departure observation.","If Tavi observed Morgan departing, that would be a departure observation."])('preserves source narrative and hypotheses: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves an actually supplied eyewitness departure',()=>expect(check("Tavi's stated observation that Fictional Morgan departed with the token supports doubt.",[{...tavi,text:tavi.text.replace('Fictional Morgan left','I saw Fictional Morgan leave')}])).toBe('passed'))
})

describe('actual outgoing profile descriptions',()=>{
 it('rejects a high skepticism claim against the captured 8/100 profile while allowing the corrected native scale',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v59-captured-profile-scale-failure.json',import.meta.url),'utf8')),q=c.request
  const audit=(value:number)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:{skepticismLevel:value,burdenSensitivity:10}},
   {packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage,courtroomState:q.courtroomState}).status
  expect(audit(8)).toBe('failed')
  expect(audit(80)).toBe('passed')
 })
})

describe('documentary absence keeps unknown classification',()=>{
 it('rejects the actual accepted V60 documentary absence rationale',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v60-captured-corrob-documentary-absence-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles[0]},
   {packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage,courtroomState:q.courtroomState}).status).toBe('failed')
 })
 it.each(['The absence of corroborating documentary proof leaves doubt.', 'There is no corroborating documentary evidence.', 'Without corroborating documentary support, I retain doubt.', 'A lack of documentary corroboration informs my vote.'])('rejects strengthened absence: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('failed'))
 it.each(['If corroborating documentary proof is absent, that would inform my assessment.', 'Documentary corroboration status remains unknown.', 'My current assessment of the permitted accounts leaves reasonable doubt.'])('preserves hypotheses and current assessments: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed'))
})

describe('captured V61 incompatibility and scoped checker rejections',()=>{
 it('rejects accepted cannot-both-be-correct against non-observation',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v61-captured-both-correct-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   undefined,{packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage}).status).toBe('failed')
 })
 it.each(['The accounts cannot both be correct.', 'On the central point they cannot both be accurate.', 'Both accounts cannot be true.'])('rejects categorical incompatibility: %s',text=>expect(check(text)).toBe('failed'))
 it.each(['If the accounts cannot both be correct, that would require incompatible propositions.', 'The accounts may conflict; I retain doubt.', 'It is not established that the accounts cannot both be correct.'])('preserves qualified comparison: %s',text=>expect(check(text)).toBe('passed'))
 it.each(['classified-documentary-positive','strategy-element-proof-absence-positive'])('preserves the exact actual scoped %s control against checker rejection',id=>{
  const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v61-captured-${id}-false-rejection.json`,import.meta.url),'utf8')),q=c.control.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.review.findings}),groundingUnits(c.control.draft),q.evidence,q.groundingContext,
   undefined,{packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage}).status).toBe('passed')
 })
 it('does not extend exact classification or strategy repairs to different scopes',()=>{
  for(const id of ['classified-documentary-positive','strategy-element-proof-absence-positive']){
   const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v61-captured-${id}-false-rejection.json`,import.meta.url),'utf8')),q=c.control.request
   const audit=(text:string,context=q.groundingContext,roles=q.courtroomActor.roles)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'unsupported',citations:[]}]}),[{id:'content:1',text}],q.evidence,context,undefined,{packet:q.packet,events:q.courtroomEvents??[],actorRoles:roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage}).status
   expect(audit(c.control.draft.content+' No evidence exists.')).toBe('failed')
   if(id==='classified-documentary-positive') expect(audit(c.control.draft.content,q.groundingContext.replaceAll('unclassified; unknown','primary_document; verified'))).toBe('failed')
   else expect(audit(c.control.draft.content,q.groundingContext,['crown'])).toBe('failed')
  }
 })
})

describe('captured V62 event polarity and primary verification',()=>{
 it.each(['event-polarity','primary-verification'])('rejects the actual accepted %s response',name=>{
  const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v62-captured-${name}-failure.json`,import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles?.[0]},
   {packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage}).status).toBe('failed')
 })
 it.each(['The accounts are conflicting on whether the blue token was handed to Ellis.', 'The statements conflict on whether Morgan handed the token to Ellis.', 'The sources conflict on whether Ellis received the token.'])('rejects event-polarity strengthening: %s',text=>expect(check(text)).toBe('failed'))
 it.each(['The supplied accounts have no primary verification.', 'Without primary verification, I retain doubt.', 'The record lacks primary verification.'])('rejects verification absence from unknown status: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('failed'))
 it.each(['The accounts conflict in my present assessment of sufficiency.', 'It is not established that the accounts conflict on whether the token was handed over.', 'If the accounts conflict on whether Morgan handed the token to Ellis, I would examine their propositions.', 'Primary verification status is not supplied.', 'If primary verification is absent, that would inform my assessment.'])('preserves qualified assessments: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed'))
})

describe('unknown verification across source clauses',()=>{
 it('rejects the actual V63 singular joined verification claim',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v63-captured-independent-verification-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   undefined,{packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage}).status).toBe('failed')
 })
 it.each(["Mira's account (E-001) rests on attribution alone and is not independently verified.", 'E-001 is unverified.', 'Neither statement has been independently verified.', 'There is no independent verification for these accounts.'])('rejects unknown verification asserted absent: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('failed'))
 it.each(['Independent verification status is unknown.', 'No independent verification status is supplied.', 'It is not established that E-001 is unverified.', 'If E-001 is unverified, that would inform my assessment.', 'The account remains attributed and disputed, not an established finding.'])('preserves status gaps and qualified assessment: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed'))
})

describe('qualified comparison keeps non-observation compatible',()=>{
 it.each(['both-correct-not-established-positive','event-conflict-not-established-positive'])('preserves actual falsely rejected %s',id=>{
  const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v64-captured-${id}-false-rejection.json`,import.meta.url),'utf8')),q=c.control.request
  const audit=(text:string,evidence=q.evidence)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'contradicted',citations:[]}]}),[{id:'content:1',text}],evidence,q.groundingContext,
   undefined,{packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles??[],stage:q.stage}).status
  expect(audit(c.control.draft.content)).toBe('passed')
  expect(audit(c.control.draft.content+' No evidence exists.')).toBe('failed')
  expect(audit(c.control.draft.content,q.evidence.map((e:EvidenceItem)=>({...e,text:e.text.replace('I did not see a handover.','No handover occurred.')})))).toBe('failed')
 })
})

describe('record citations do not exempt independent clauses',()=>{
 const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v65-captured-mixed-record-source-failure.json',import.meta.url),'utf8')),q=c.request
 const event=q.courtroomEvents.find((e:{type:string;actorId:string})=>e.type==='public_submission'&&e.actorId==='crown')
 const audit=(text:string)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'analysis',citations:[{exhibitId:'E-001',paragraph:1},{exhibitId:'E-002',paragraph:1}],recordCitations:[{eventId:event.eventId}]}]}),[{id:'content:1',text}],q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
 it('rejects the actual mixed accepted rationale',()=>expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed'))
 it.each(['E-001 and E-002 conflict directly on the same handover', 'Tavi observed Rowan departing with the token', 'No documentary corroboration exists', 'The token never left Rowan hand'])('rejects independent claim with a valid record citation: %s',claim=>expect(audit(claim+"; the Crown's own submission concedes the record does not resolve it.")).toBe('failed'))
 it.each(["The Crown's own submission concedes the record does not resolve it.", "E-001 describes Mira handover account; the Crown's own submission concedes the record does not resolve it."])('preserves pure record attribution and supported mixed clauses: %s',text=>expect(audit(text)).toBe('passed'))
 it('preserves actual present Defence agreement without invented prior agreement',()=>{
  const capture=JSON.parse(readFileSync(new URL('../docs/qa/jury/v65-captured-present-agreement-false-rejection.json',import.meta.url),'utf8')),request=capture.control.request
  const evaluate=(events=request.courtroomEvents)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:capture.result.review.findings}),groundingUnits(capture.control.draft),request.evidence,request.groundingContext,undefined,{packet:request.packet,events,actorRoles:request.courtroomActor.roles,partyRoles:request.approvedPartyRoles,stage:request.stage}).status
  expect(evaluate()).toBe('passed')
  expect(evaluate(request.courtroomEvents.filter((e:{actorId:string})=>e.actorId!=='crown'))).toBe('failed')
 })
})

describe('categorical contradiction and verification absence keep their premises',()=>{
 it.each(['genuine-contradiction','without-independent-verification'])('rejects captured V67 %s',name=>{
  const c=JSON.parse(readFileSync(new URL(`../docs/qa/jury/v67-captured-${name}-failure.json`,import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles?.[0]},
   {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed')
 })
 it.each(['The genuine contradiction prevents a firm conclusion.', 'The actual contradiction leaves doubt.', 'A real contradiction prevents a firm conclusion.'])('requires incompatible propositions: %s',text=>expect(check(text)).toBe('failed'))
 it.each(['An attributed account without independent verification requires assessment.', 'The account lacks independent verification.', 'There is an absence of independent verification.'])('keeps unknown verification distinct from absence: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('failed'))
 it('preserves actual denial, qualified comparison and unknown status',()=>{
  expect(check('The genuine contradiction prevents a firm conclusion.',[mira,{...tavi,text:'Tavi states: No handover occurred.'}])).toBe('passed')
  expect(check('If a genuine contradiction exists, it may affect assessment.')).toBe('passed')
  expect(check('It is not established that a genuine contradiction exists.')).toBe('passed')
  expect(check('No independent verification status is supplied.',[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed')
  expect(check('If the account lacks independent verification, that may affect assessment.',[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed')
 })
})

describe('corroboration existence needs scope or actual support',()=>{
 it('rejects captured V68 unqualified existence assertion',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v68-captured-corroboration-existence-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles?.[0]},
   {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed')
 })
 it.each(['No corroboration exists.', 'No independent corroboration exists.', 'Corroboration does not exist.', 'No evidence exists.'])('rejects unsupported existence: %s',text=>expect(check(text)).toBe('failed'))
 it.each(['No additional source beyond E-001 and E-002 is supplied in this run.', 'If no corroboration exists, that may affect assessment.', 'It is not established that no corroboration exists.'])('preserves source inventory and qualifications: %s',text=>expect(check(text)).toBe('passed'))
 it('does not use record scope as proof of no corroboration of any kind',()=>expect(check('On the supplied record, no corroboration exists.')).toBe('failed'))
 it('does not infer no corroboration of any kind from a supplied-source inventory',()=>expect(check('No corroboration is supplied in this run.')).toBe('failed'))
 it('preserves a single distinct source inventory without certifying underlying absence',()=>{
  expect(check('No corroboration is supplied; I assess this disputed account as insufficient on this record.',[mira])).toBe('passed')
  expect(check('No corroboration exists.',[mira])).toBe('failed')
 })
})

describe('qualified contradiction survives a false checker denial',()=>{
 it('preserves actual V69 qualification only with compatible full source propositions',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v69-captured-qualified-contradiction-false-rejection.json',import.meta.url),'utf8')),q=c.control.request
  const audit=(text:string,evidence=q.evidence)=>reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:[{unitId:'content:1',status:'contradicted',citations:[]}]}),[{id:'content:1',text}],evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.review.findings}),groundingUnits(c.control.draft),q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('passed')
  expect(audit(c.control.draft.content+' No evidence exists.')).toBe('failed')
  expect(audit(c.control.draft.content,q.evidence.map((e:EvidenceItem)=>({...e,text:e.text.replace('I did not see a handover.','No handover occurred.')})))).toBe('failed')
 })
})


describe('coordinated documentary absence preserves unknown classification',()=>{
 it('rejects the actual V72 accepted documentary absence',()=>{
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v72-captured-coordinated-documentary-absence-failure.json',import.meta.url),'utf8')),q=c.request
  expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:c.result.grounding.findings}),groundingUnits(c.result),q.evidence,q.groundingContext,
   {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles?.[0]},
   {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed')
 })
 it.each(['With no corroboration or documentary evidence, I retain doubt.', 'Without corroboration or documentary support, I retain doubt.', 'The record lacks corroboration and documentary evidence.', 'There is an absence of corroboration or documentary proof.'])('rejects coordinated absence: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('failed'))
 it.each(['If there is no corroboration or documentary evidence, that may inform assessment.', 'It is not established that there is no corroboration or documentary evidence.', 'Documentary evidence status is unknown.'])('preserves qualified unknown status: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed'))
})

describe('affirmative conflict and corroborating exhibit absence need premises',()=>{
 const capture=JSON.parse(readFileSync(new URL('../docs/qa/jury/v73-captured-affirmative-conflict-corroborating-exhibit-failure.json',import.meta.url),'utf8')),q=capture.request
 it('rejects the actual accepted V73 ballot',()=>expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:capture.result.grounding.findings}),groundingUnits(capture.result),q.evidence,q.groundingContext,
  {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[],profile:q.jurorProfiles?.[0]},
  {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status).toBe('failed'))
 it.each(['Departure affirmatively conflicts with receipt.', 'The accounts have an affirmative conflict on receipt.', 'E-001 and E-002 conflict affirmatively on receipt.'])('rejects categorical incompatibility: %s',text=>expect(check(text)).toBe('failed'))
 it.each(['There is no corroborating exhibit.', 'Without a corroborating source, I retain doubt.', 'The record lacks corroborating evidence.'])('rejects unknown corroborating-source absence: %s',text=>expect(check(text,[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('failed'))
 it('permits actual opposite events and qualified source assessments',()=>{
  expect(check('Departure affirmatively conflicts with receipt.',[mira,{...tavi,text:'Tavi states: No handover occurred.'}])).toBe('passed')
  expect(check('If the accounts have an affirmative conflict on receipt, that could affect assessment.')).toBe('passed')
  expect(check('The accounts do not affirmatively conflict on receipt.')).toBe('passed')
  expect(check('It is not established that there is no corroborating exhibit.',[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed')
  expect(check('If there is no corroborating exhibit, that could inform assessment.',[mira,tavi],assessment+'\nE-001: unclassified; unknown;\nE-002: unclassified; unknown;')).toBe('passed')
 })
})
