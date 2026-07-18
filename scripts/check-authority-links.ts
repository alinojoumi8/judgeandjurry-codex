import { listCuratedAuthorities } from '../server/authorityRegistry'
import { procedureAdapters } from '../server/procedureAdapters'

const strict = process.argv.includes('--strict')
const failures: string[] = []

const registryLinks = [
  ...listCuratedAuthorities().map((authority) => ({ id: authority.id, sourceUrl: authority.sourceUrl })),
  ...Object.values(procedureAdapters).flatMap((adapter) =>
    adapter.legalSources.map((source, index) => ({
      id: `${adapter.id}:source-${index + 1}`,
      sourceUrl: source.sourceUrl,
    })),
  ),
]
const uniqueLinks = [...new Map(registryLinks.map((link) => [link.sourceUrl, link])).values()]

console.log('Checking curated source URLs for availability only; this is not citator or legal-validity verification.')
for (const authority of uniqueLinks) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(authority.sourceUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Judge-Jury-Authority-Link-Check/1.0' },
    })
    if (!response.ok) {
      failures.push(`${authority.id}: HTTP ${response.status} ${authority.sourceUrl}`)
    } else {
      console.log(`PASS ${authority.id} ${response.status}`)
    }
  } catch (error) {
    failures.push(
      `${authority.id}: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timeout)
  }
}

if (failures.length > 0) {
  console.error('Authority source link warnings:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  if (strict) {
    process.exitCode = 1
  }
}
