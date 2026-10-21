import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
const id='3164e153-f873-4b70-879f-fffadf646a1c'
const event={eventId:id,type:'juror_deliberation_turn',actorId:'juror-01',payload:{contribution:'E-001 is limited to attribution, not proof. No corroborating source supplied.'}}
function check(prefix:string,extra=false){const text=`The corroboration gap and source-use limit identified in deliberation event ${prefix} shifted my initial guilty lean once attributed-only material was assessed against the beyond-reasonable-doubt burden.`;return parseGroundingReview(JSON.stringify({findings:[{unitId:'juror-change-0:1',status:'supported',citations:[],recordCitations:[{eventId:id}]}]}),[{id:'juror-change-0:1',text}],[], '',undefined,{packet:'',events:extra?[event,{...event,eventId:'3164e153-1111-1111-1111-111111111111'}]:[event],actorRoles:['juror'],partyRoles:[]})}
describe('visible deliberation event attribution',()=>{
 it('supports an exact visible event reference instead of requiring an exhibit quote',()=>expect(check(id).status).toBe('passed'))
 it('supports an unambiguous short reference to the actual cited event',()=>expect(check('3164e153').status).toBe('passed'))
 it('rejects naming a different event even with a valid record citation',()=>expect(check('deadbeef').status).toBe('failed'))
 it('requires a full ID when a short prefix is ambiguous',()=>expect(check('3164e153',true).status).toBe('failed'))
})
