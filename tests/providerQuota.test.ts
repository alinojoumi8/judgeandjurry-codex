import {describe,it,expect} from 'vitest'
import {isMiniMaxQuotaExhaustion} from '../server/providerQuota'
describe('MiniMax quota classification without credential or network access',()=>{
 it.each([
  [429,JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)'}})],
  [429,JSON.stringify({error:{code:2056}})],
  [403,JSON.stringify({base_resp:{status_code:'2056'}})],
  [402,JSON.stringify({error:{message:'Insufficient account funds'}})],
  [429,'Monthly usage quota exhausted'],
  [429,'Weekly quota exceeded'],
 ])('recognizes a real quota stop (%s,%s)',(status,raw)=>expect(isMiniMaxQuotaExhaustion(status as number,raw as string)).toBe(true))
 it.each([
  [429,JSON.stringify({error:{type:'rate_limit_error',message:'Requests per minute limit exceeded'}})],
  [429,'Tokens per minute limit exceeded'],
  [429,'Rate limit, retry in 10 seconds'],
  [429,'Quota exceeded; try again shortly'],
  [401,'Token Plan usage limit reached'],
  [500,'Token Plan usage limit reached'],
  [200,JSON.stringify({error:{code:2056}})],
  [429,JSON.stringify({error:{message:123,request_id:'2056'}})],
  [429,JSON.stringify({error:null})],
  [403,JSON.stringify({error:{message:'Region not permitted'}})],
  [429,'null'],[429,'[]'],[429,'true'],[429,'0'],
 ])('does not switch providers for other errors (%s,%s)',(status,raw)=>expect(isMiniMaxQuotaExhaustion(status as number,raw as string)).toBe(false))
})
