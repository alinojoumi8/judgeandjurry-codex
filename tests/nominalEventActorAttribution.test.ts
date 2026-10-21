import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
import {MiniMaxClient,type StageRequest} from '../server/minimax'
const c=JSON.parse(readFileSync('docs/qa/jury/v157-nominal-event-attribution-capture.json','utf8'))
const raw=JSON.parse(readFileSync('docs/qa/jury/v157-nominal-event-attribution-checker-raw.json','utf8')).checkerContent
const request=c.request as StageRequest
const bad=c.result.jurors[0].rationale as string
function draft(text:string){return {...c.result,title:'Juror response',content:text,jurors:c.result.jurors.map((j:any)=>({...j,rationale:text,mindChangedBecause:'This is my initial assessment.'}))}}
function check(r=c.result,q=request,status='analysis',records:string[]=[]){
 const units=groundingUnits(r)
 return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status,explanation:'Source attribution reviewed.',citations:status==='supported'?q.evidence.map(e=>({exhibitId:e.exhibitId,quote:e.text})):[],recordCitations:records}))}),units,q.evidence,q.groundingContext,{actorId:q.courtroomActor!.id,assessments:q.courtroomAssessments??[]},{packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor!.roles,partyRoles:q.approvedPartyRoles??[],actor:q.courtroomActor,stage:q.stage,ballotRound:q.ballotRound}).status
}
describe('attributing an event to an account speaker is distinct from attributing that speaker account',()=>{
 it('withholds the exact newly accepted rationale through the production checker',async()=>{
  const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries:0},undefined,async()=>Response.json({choices:[{message:{content:raw}}]}))
  expect((await client.reviewGrounding(request,c.result)).status).toBe('failed')
 })
 it.each(['analysis','supported','unsupported','contradicted'])('rejects the captured event-actor attribution under checker %s',status=>expect(check(undefined,undefined,status)).toBe('failed'))
 it.each(['title','content','rationale','mindChangedBecause'])('checks current %s despite correct adjacent fields',field=>{
  const r=draft('I retain reasonable doubt about receipt after weighing the accounts.')
  if(field==='title'||field==='content')r[field]=bad
  else r.jurors[0][field]=bad
  expect(check(r)).toBe('failed')
 })
 it('binds renamed actual speakers, event participants and exhibit IDs',()=>{
  const rename=(v:any)=>JSON.parse(JSON.stringify(v).replaceAll('Mira','Nira').replaceAll('Tavi','Savi').replaceAll('Rowan','Orin').replaceAll('Ellis','Evan').replaceAll('E-001','E-731').replaceAll('E-002','E-732'))
  expect(check(rename(c.result),rename(request))).toBe('failed')
 })
 it.each([
  'E-002 attributes a departure with the token to Tavi.',
  'E-002 attributes to Tavi a departure with the token.',
  'E-001 attributes a desk handover to Mira.',
 ])('does not turn a source speaker into the event actor: %s',text=>expect(check(draft(text))).toBe('failed'))
 it('does not let accurate report ownership in one attribution hide a later wrong event actor',()=>{
  expect(check(draft("E-001 attributes Mira's account of Rowan handing the token to Ellis, while E-002 attributes a departure with the token to Tavi."))).toBe('failed')
 })
 it.each([
  'E-002 attributes to Tavi an account of Rowan leaving with the token and personal non-observation of a handover.',
  'E-002 attributes the departure account to Tavi.',
  "E-001 attributes Mira's account of Rowan handing the token to Ellis.",
  'Mira reports Rowan handing the blue token to Ellis at the desk.',
 ])('preserves accurate report ownership: %s',text=>expect(check(draft(text))).toBe('passed'))
 it('preserves a source that actually attributes its own speaker departure',()=>{
  const q={...request,evidence:request.evidence.map(e=>({...e,text:e.text.replace('Fictional Rowan left','Fictional Tavi left')}))}
  expect(check(draft('E-002 attributes a departure with the token to Tavi.'),q)).toBe('passed')
 })
 it('preserves a source whose speaker is actually a handover participant',()=>{
  const q={...request,evidence:request.evidence.map(e=>({...e,text:e.text.replace('Fictional Rowan hand','Fictional Mira hand')}))}
  expect(check(draft('E-001 attributes a desk handover to Mira.'),q)).toBe('passed')
 })
 it('binds nominal attribution to its actual exhibit rather than another account by the same speaker',()=>{
  const q={...request,evidence:[...request.evidence.map(e=>({...e,text:e.text.replace('Fictional Rowan left','Fictional Tavi left')})),{...request.evidence[1],exhibitId:'E-003'}]}
  expect(check(draft('E-002 attributes a departure with the token to Tavi.'),q)).toBe('passed')
 })
 it('preserves accurate non-adopted reporting of a visible party statement',()=>{
  const eventId='fictional-nominal-attribution-report',text='E-002 attributes a departure with the token to Tavi.'
  const q={...request,courtroomEvents:[...(request.courtroomEvents??[]),{eventId,type:'public_submission',actorId:'crown',payload:{text}}]} as StageRequest
  expect(check(draft(`The Crown argued, "${text}"`),q,'analysis',[eventId])).toBe('passed')
 })
})
