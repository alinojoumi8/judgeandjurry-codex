import {describe,it,expect} from 'vitest'
import {groundingCorrectionUnits,groundingToolContent,mergeGroundingCorrection} from '../server/groundingFormat'
import {parseGroundingReview} from '../server/grounding'
const units=Array.from({length:30},(_,i)=>({id:i?'content:'+i:'title:1',text:'I retain doubt.'}))
const row={status:'analysis',supportTypes:['analysis'],explanation:'An assessment.',citations:[],recordCitations:[]}
const initial=()=>({findings:Object.fromEntries(units.map(unit=>[unit.id,{...row}]))})
describe('30 row completeness and delivery',()=>{
 it.each(['citations','recordCitations','both'])('targets only explicit missing %s',field=>{
  const data:any=initial();for(const f of field==='both'?['citations','recordCitations']:[field])delete data.findings['title:1'][f]
  const raw=JSON.stringify(data),review=parseGroundingReview(raw,units,[])
  expect(review.status).toBe('failed');expect(groundingCorrectionUnits(units,review,raw)).toEqual([units[0]])
  const merged=mergeGroundingCorrection(raw,JSON.stringify({findings:{'title:1':row}}),units,[units[0]])
  expect(parseGroundingReview(merged,units,[]).status).toBe('passed')
  expect(JSON.parse(merged).findings['content:29']).toEqual(data.findings['content:29'])
 })
 it.each(['extra','unknown','negative'])('does not scope unsafe %s',kind=>{
  const data:any=initial();delete data.findings['title:1'].citations
  if(kind==='extra')data.extra=true
  if(kind==='unknown'){delete data.findings['content:1'];data.findings['unknown']=row}
  if(kind==='negative')data.findings['title:1'].status='unsupported'
  const raw=JSON.stringify(data);expect(groundingCorrectionUnits(units,parseGroundingReview(raw,units,[]),raw)).toEqual(units)
 })
 it.each(["I'll audit each unit against the permitted source record.","I'll audit each unit against the actual supplied sources."])('accepts procedural wording without changing arguments %s',content=>{
  const raw=JSON.stringify(initial()),m={content,tool_calls:[{type:'function',function:{name:'record_grounding_review',arguments:raw}}]}
  expect(groundingToolContent(m)).toBe(raw)
  for(const extra of [' All findings are supported.',' {"findings":{}}',' E-001 proves it.'])expect(()=>groundingToolContent({...m,content:content+extra})).toThrow()
 })
})
