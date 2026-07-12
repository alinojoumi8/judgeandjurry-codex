import type { VerifiedAuthority } from './types'

export const curatedAuthorityRegistry: Readonly<Record<string, VerifiedAuthority>> = {
  'CC-515': authority(
    'CC-515',
    'Criminal Code judicial interim release',
    'Criminal Code, R.S.C. 1985, c. C-46, s. 515',
    'https://laws-lois.justice.gc.ca/eng/acts/C-46/section-515.html',
    'statute',
    'The statutory bail framework for judicial interim release, detention, and release conditions.',
  ),
  'ANTIC-2017-SCC-27': authority(
    'ANTIC-2017-SCC-27',
    'R. v. Antic',
    'R. v. Antic, 2017 SCC 27',
    'https://scc-csc.lexum.com/scc-csc/scc-csc/en/item/16649/index.do',
    'court-decision',
    'Supreme Court of Canada authority for the bail ladder principle and least onerous form of release.',
  ),
  'BAIL-GROUNDS-515-10': authority(
    'BAIL-GROUNDS-515-10',
    'Primary, secondary, and tertiary bail grounds',
    'Criminal Code, s. 515(10)',
    'https://laws-lois.justice.gc.ca/eng/acts/C-46/section-515.html',
    'statute',
    'Detention grounds commonly framed as attendance in court, public protection, and confidence in the administration of justice.',
  ),
  'ZORA-2020-SCC-14': authority(
    'ZORA-2020-SCC-14',
    'R. v. Zora',
    'R. v. Zora, 2020 SCC 14',
    'https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18391/index.do',
    'court-decision',
    'Supreme Court of Canada authority relevant to restraint and precision in bail conditions and breach analysis.',
  ),
  'ST-CLOUD-2015-SCC-27': authority(
    'ST-CLOUD-2015-SCC-27',
    'R. v. St-Cloud',
    'R. v. St-Cloud, 2015 SCC 27',
    'https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/15358/index.do',
    'court-decision',
    'Supreme Court of Canada authority commonly cited for tertiary-ground bail analysis.',
  ),
  'CC-606': authority(
    'CC-606',
    'Criminal Code pleas and guilty plea safeguards',
    'Criminal Code, R.S.C. 1985, c. C-46, s. 606',
    'https://laws-lois.justice.gc.ca/eng/acts/C-46/section-606.html',
    'statute',
    'Statutory plea framework, including safeguards before accepting a guilty plea.',
  ),
  'JORDAN-2016-SCC-27': authority(
    'JORDAN-2016-SCC-27',
    'R. v. Jordan',
    'R. v. Jordan, 2016 SCC 27',
    'https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/16057/index.do',
    'court-decision',
    'Supreme Court of Canada authority on trial-delay ceilings; included for resolution-conference issue spotting.',
  ),
}

export function listCuratedAuthorities(): VerifiedAuthority[] {
  return Object.values(curatedAuthorityRegistry)
}

function authority(
  id: string,
  title: string,
  citation: string,
  sourceUrl: string,
  sourceKind: VerifiedAuthority['sourceKind'],
  summary: string,
): VerifiedAuthority {
  return {
    id,
    title,
    citation,
    sourceUrl,
    sourceKind,
    summary,
    provenance: 'curated',
    checkedAt: null,
    jurisdiction: 'Canada',
    note: 'Curated local registry entry; not a live citator or statute-version check.',
  }
}
