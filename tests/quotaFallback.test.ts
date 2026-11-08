import {afterEach,describe,it,expect,vi} from 'vitest'
import {MiniMaxClient,ModelProviderError,createMiniMaxConfig,type ModelProviderConfig,type StageRequest} from '../server/minimax'
import {noopLogger} from '../server/logger'
import {providerCallAudit} from '../server/providerCallTypes'
const quota=()=>Response.json({error:{type:'rate_limit_error',message:'Token Plan usage limit reached (2056)'}},{status:429})
const ok=(content='I retain doubt.')=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'Assessment',content,citations:[],jurors:[]})}}]})
const cfg=():ModelProviderConfig=>({provider:'minimax',apiKey:'primary-fixture-secret',model:'MiniMax-M3',baseUrl:'https://minimax.invalid/v1',timeoutMs:1000,maxRetries:0,quotaFallback:{readApiKey:async()=> 'fallback-fixture-secret'}})
const request:StageRequest={stage:'defence_rebuttal',packet:'Fictional case.',previousTurns:'',evidence:[],civilMotionHearing:true}
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers()})
describe('quota-only OpenCode fallback',()=>{
 it('does not send anything for a local-mode request on the external client',async()=>{
  let calls=0;const client=new MiniMaxClient(cfg(),undefined,async()=>{calls++;return quota()})
  await expect(client.generateStage({...request,runConfig:{providerMode:'local',externalDisclosureConfirmed:true} as StageRequest['runConfig']})).rejects.toThrow(/Local provider mode/)
  expect(calls).toBe(0)
 })
 it('does not switch after malformed model JSON',async()=>{
  const c=cfg();const key=vi.fn(async()=> 'fallback');c.quotaFallback!.readApiKey=key;let calls=0
  const client=new MiniMaxClient(c,undefined,async()=>{calls++;return Response.json({choices:[{message:{content:'broken JSON'}}]})})
  await expect(client.generateStage(request)).rejects.toThrow(/JSON/);expect(calls).toBe(1);expect(key).not.toHaveBeenCalled()
 })
 it.each([402,429])('records OpenCode HTTP%s failure without routing back or hiding it',async status=>{
  const client=new MiniMaxClient(cfg(),undefined,async url=>String(url).includes('minimax.invalid')?quota():Response.json({error:{message:'quota exhausted'}},{status}))
  try{await client.generateStage(request);throw new Error('Unexpected success')}catch(error){expect(error).toBeInstanceOf(ModelProviderError);const e=error as ModelProviderError;expect(e.message).toContain('OpenCode');expect(e.providerCalls?.map(c=>[c.provider,c.status])).toEqual([['minimax',429],['opencode',status]])}
 })

 it('uses the same payload, timeout, output cap and budget fetcher with distinct credentials',async()=>{
  vi.stubEnv('MODEL_MAX_OUTPUT_TOKENS','200');const calls:Array<{url:string;init:RequestInit;body:any}>=[]
  const logger=noopLogger(),logs:unknown[]=[];vi.spyOn(logger,'info').mockImplementation((...args)=>{logs.push(args)});vi.spyOn(logger,'warn').mockImplementation((...args)=>{logs.push(args)})
  const client=new MiniMaxClient(cfg(),logger,async(url,init)=>{calls.push({url:String(url),init:init!,body:JSON.parse(String(init!.body))});return calls.length===1?quota():ok()})
  const result=await client.generateStage(request)
  expect(calls).toHaveLength(2);expect(calls[1].url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
  expect(calls[1].body.model).toBe('deepseek-v4.1-flash');expect(calls[1].body.messages).toEqual(calls[0].body.messages)
  expect(calls[1].body.max_tokens).toBe(calls[0].body.max_completion_tokens);expect(calls[1].body.max_tokens).toBe(200)
  expect(calls[1].body).not.toHaveProperty('max_completion_tokens');expect(calls[1].body.thinking).toEqual({type:'disabled'})
  expect(calls[1].init.signal).toBe(calls[0].init.signal)
  expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer primary-fixture-secret')
  expect(new Headers(calls[1].init.headers).get('Authorization')).toBe('Bearer fallback-fixture-secret')
  expect(new Headers(calls[1].init.headers).get('User-Agent')).toBe('TrialLens/1.0')
  expect(result.providerCalls?.map(c=>[c.provider,c.status])).toEqual([['minimax',429],['opencode',200]])
  expect(result.providerCalls?.[1].promptHash).toBe(result.providerCalls?.[0].promptHash)
  expect(providerCallAudit(result.providerCalls,{provider:'minimax',model:'MiniMax-M3'}).provider).toBe('opencode')
  expect(JSON.stringify(logs)).not.toContain('fixture-secret')
 })
 it.each([401,403,500,429])('does not switch on nonquota HTTP%s',async status=>{
  let calls=0;const client=new MiniMaxClient(cfg(),undefined,async()=>{calls++;return Response.json({error:{message:'Temporary rate limit or other service error'}},{status})})
  await expect(client.generateStage(request)).rejects.toBeInstanceOf(ModelProviderError);expect(calls).toBe(1)
 })
 it('does not route local clients or disabled fallback externally',async()=>{
  const config=cfg();delete config.quotaFallback;let calls=0
  await expect(new MiniMaxClient(config,undefined,async()=>{calls++;return quota()}).generateStage(request)).rejects.toThrow();expect(calls).toBe(1)
  const local={...cfg(),provider:'openai-compatible' as const,baseUrl:'http://localhost:11434/v1'};calls=0
  await expect(new MiniMaxClient(local,undefined,async()=>{calls++;return quota()}).generateStage(request)).rejects.toThrow();expect(calls).toBe(1)
 })
 it('does not fall back when disclosure was not confirmed',async()=>{
  let calls=0;const client=new MiniMaxClient(cfg(),undefined,async()=>{calls++;return quota()})
  await expect(client.generateStage({...request,runConfig:{providerMode:'external',externalDisclosureConfirmed:false} as StageRequest['runConfig']})).rejects.toThrow();expect(calls).toBe(1)
 })
 it('fails closed on absent or unreadable saved fallback credentials',async()=>{
  for(const fail of [false,true]){let calls=0;const c=cfg();c.quotaFallback!.readApiKey=async()=>{if(fail)throw new Error('sensitive-key-details');return undefined}
   await expect(new MiniMaxClient(c,undefined,async()=>{calls++;return quota()}).generateStage(request)).rejects.toThrow(/OpenCode/);expect(calls).toBe(1)
  }
 })
 it('keeps the original request deadline during credential loading',async()=>{
  const c=cfg();c.timeoutMs=10;c.quotaFallback!.readApiKey=async()=>{await new Promise(r=>setTimeout(r,25));return 'fixture'};let calls=0
  await expect(new MiniMaxClient(c,undefined,async()=>{calls++;return quota()}).generateStage(request)).rejects.toThrow(/timed out/);expect(calls).toBe(1)
 })
 it('does not bypass an exhausted caller HTTP budget',async()=>{
  let calls=0;const client=new MiniMaxClient(cfg(),undefined,async()=>{if(++calls>1)throw new Error('HTTP budget exhausted');return quota()})
  await expect(client.generateStage(request)).rejects.toThrow('HTTP budget exhausted');expect(calls).toBe(2)
 })
 it('holds the quota route briefly, then probes MiniMax again',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01'));const config=cfg();const routes:string[]=[];let recovered=false
  const client=new MiniMaxClient(config,undefined,async url=>{routes.push(String(url));return String(url).includes('minimax.invalid')&&!recovered?quota():ok()})
  await client.generateStage(request);await client.generateStage(request);expect(routes).toHaveLength(3);expect(routes[2]).toContain('opencode.ai')
  recovered=true;vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));await client.generateStage(request);expect(routes[3]).toContain('minimax.invalid')
 })
 it('isolates concurrent call traces and opaque sessions',async()=>{
  const headers:string[]=[];const client=new MiniMaxClient(cfg(),undefined,async(url,init)=>{if(String(url).includes('minimax.invalid'))return quota();headers.push(new Headers(init?.headers).get('x-opencode-session')!);return ok()})
  const results=await Promise.all([client.generateStage({...request,packet:'case-A'}),client.generateStage({...request,packet:'case-B'})])
  expect(new Set(headers).size).toBe(2);for(const r of results){expect(r.providerCalls?.filter(c=>c.provider==='opencode')).toHaveLength(1);expect(new Set(r.providerCalls?.map(c=>c.promptHash)).size).toBe(1)}
 })
 it('retains all source checks after fallback',async()=>{
  let calls=0;const client=new MiniMaxClient(cfg(),undefined,async(url)=>{calls++;if(String(url).includes('minimax.invalid'))return quota();if(calls===2)return ok('An unsupported claim.');return Response.json({choices:[{message:{tool_calls:[{type:'function',function:{name:'record_grounding_review',arguments:JSON.stringify({findings:{'title:1':{status:'analysis',supportTypes:['analysis'],explanation:'Heading.',citations:[],recordCitations:[]},'content:1':{status:'unsupported',supportTypes:['source'],explanation:'No source supports the claim.',citations:[],recordCitations:[]}}})}}]}}]})})
  await expect(client.generateStage({...request,groundingRequired:true})).rejects.toThrow(/Source verification rejected/);expect(calls).toBe(3)
 })
})


describe('persisted provider audit identity', () => {
 it('attributes the author and checker independently when the quota expires mid-stage', () => {
  const calls=[
   {provider:'minimax',model:'MiniMax-M3',stage:'defence_rebuttal',promptHash:'author-hash',status:200},
   {provider:'minimax',model:'MiniMax-M3',stage:'grounding_check',promptHash:'checker-hash',status:429},
   {provider:'opencode',model:'deepseek-v4.1-flash',stage:'grounding_check',promptHash:'checker-hash',status:200,fallbackReason:'minimax_quota_exhausted' as const},
  ]
  const audit=providerCallAudit(calls,{provider:'minimax',model:'MiniMax-M3'},'defence_rebuttal')
  expect(audit.provider).toBe('minimax')
  expect(audit.providerCalls?.map(c=>c.provider)).toEqual(['minimax','minimax','opencode'])
  expect(providerCallAudit(calls,{provider:'minimax',model:'MiniMax-M3'}).provider).toBe('opencode')
  expect(JSON.parse(JSON.stringify(audit))).toEqual(audit)
  calls[0].status=500
  expect(audit.providerCalls?.[0].status).toBe(200)
 })
})


it('requires the fallback flag and keeps local provider configuration local',()=>{
 vi.stubEnv('MODEL_PROVIDER','minimax');vi.stubEnv('OPENCODE_QUOTA_FALLBACK','false')
 expect(createMiniMaxConfig().quotaFallback).toBeUndefined()
 vi.stubEnv('OPENCODE_QUOTA_FALLBACK','true');vi.stubEnv('OPENCODE_CREDENTIALS_PATH','fixture.dpapi')
 expect(createMiniMaxConfig().quotaFallback?.credentialPath).toBe('fixture.dpapi')
 vi.stubEnv('MODEL_PROVIDER','openai-compatible')
 expect(createMiniMaxConfig().quotaFallback).toBeUndefined()
})
